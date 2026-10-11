const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');

// Import models
const User = require('../../models/User');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const Account = require('../../models/Account');
const Combo = require('../../models/Combo');

const { asString } = require('../../utils/query-guard');
const { withTransaction } = require('../../utils/transaction');
const { dataSnapshot } = require('../../data');
const { isDuplicateKeyError, duplicateKeyFields } = require('../../data/errors');
const {
	SNAPSHOT_FORMAT_VERSION,
	CREDENTIAL_SECTIONS,
	storedOrderTotal,
	validateSnapshot,
	buildMetadata
} = require('../../data/snapshot');
const { ERROR_CODES, ERROR_MESSAGES, ERROR_CODE_TO_HTTP_STATUS } = require('../../constants/errorCodes');
const { RESTORE_CONFIRMATION } = require('@sab/shared');
const {
	PUBLIC_CODE_PATTERN,
	isPublicCodeDuplicate,
	withPublicCodeRetry,
	createWithPublicCodeRetry
} = require('../../utils/public-code');
const { recordAppliedOpening, reconcile, enqueueMovements } = require('../../services/stock-ledger');
const { gated, close: closeWriteGate, open: openWriteGate, WriteGateError } = require('../../services/write-gate');

const router = express.Router();

// Configure multer for file uploads.
// 10MB, down from the previous 50MB: JSON.parse on the whole buffer plus the
// in-memory multer buffer itself means peak transient memory is roughly 5x
// the file size, and this endpoint has no legitimate reason to restore a file
// larger than the business data (products/combos/orders) could ever produce.
// frontend/nginx.conf's `/api/admin/database/import` and `/restore` locations
// must stay at or above this limit (F10) — nginx previously allowed 50M for a
// route that has only ever accepted 10M at the multer layer, so an oversized
// file failed with a generic 500 instead of the explicit 413/400 nginx or the
// handler below now produce.
const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// The export refuses to produce a file above this. Exposed so a test can lower it.
const limits = { maxFileSize: MAX_IMPORT_FILE_SIZE };

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: MAX_IMPORT_FILE_SIZE
	},
	fileFilter: (req, file, cb) => {
		if (file.mimetype === 'application/json') {
			cb(null, true);
		} else {
			cb(new Error('Only JSON files are allowed'), false);
		}
	}
});

/**
 * Only these fields can be written by a merge-imported record.
 *
 * `createdAt`/`updatedAt` are absent from every whitelist on purpose:
 * Mongoose manages timestamps itself when the field is left out, so an
 * imported record cannot backdate itself. (A restore is the opposite case: it
 * reproduces the store's own rows, timestamps included.)
 *
 * `_id` IS whitelisted for `products` and `combos` (F2): order
 * `items[].productId` / `comboInfo.comboId` are imported verbatim from the
 * file, still pointing at the *original* ids. If products/combos got fresh
 * ids on every import, a restore would produce a database whose orders
 * reference products that no longer exist (populate → null, dashboard
 * `$group` by productId splits). Phase 08's instinct not to trust a
 * client-supplied `_id` is kept, just moved from "discard it" to "validate
 * it" — see `pick()` below, which only accepts a well-formed 24-hex ObjectId
 * string and silently drops anything else, exactly as before.
 *
 * `orders` excludes both `_id` (nothing a merge writes references an order's
 * own id) and `totalAmount` — Phase 05 closed the hole where a client sets its
 * own order total; accepting it from a file would reopen exactly that hole. The
 * total is recomputed from the (whitelisted) `items` array by storedOrderTotal()
 * instead of trusted from the file.
 *
 * A new order keeps its descriptive history (`statusHistory`, `internalNotes`,
 * `itemsHistory`, `itemsRevision`): none of it prices anything or moves stock,
 * and dropping it made an export followed by an import quietly lose it.
 * `stockDeducted` is deliberately NOT accepted: the flag must always be backed
 * by a deduction movement in the ledger, and a merged order has none, so a
 * later cancel would add back units that were never taken. Only a restore
 * carries it, because the ledger comes with it.
 */
const IMPORT_WHITELIST = {
	products: [
		'_id', 'publicCode', 'name', 'description', 'price', 'imageUrl', 'category', 'available',
		'isActive', 'salesChannel', 'stockQuantity', 'minOrderQuantity', 'maxOrderQuantity',
		'sku', 'tags', 'weight', 'dimensions', 'featured', 'salePrice',
		'saleStartDate', 'saleEndDate'
	],
	combos: ['_id', 'publicCode', 'name', 'description', 'price', 'categoryRequirements', 'isActive', 'salesChannel', 'priority'],
	orders: [
		'phoneNumber', 'orderCode', 'orderNumber', 'studentId', 'fullName', 'email',
		'additionalNote', 'items', 'status', 'transactionCode', 'cancelReason',
		'lastUpdatedBy', 'isDirectSale', 'comboInfo', 'statusUpdatedAt',
		'statusHistory', 'internalNotes', 'itemsHistory', 'itemsRevision'
	]
};

/** A 24-char hex string — the only shape `JSON.stringify`d ObjectId export produces. */
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// A merge import writes business data only. Credential sections are never
// written; a file that includes one is not silently dropped, its record count
// is reported back so an admin importing a real backup notices the gap instead
// of being told "0 errors".
const REJECTED_SECTIONS = CREDENTIAL_SECTIONS;

// v2 files carry these too; a merge never writes them (movements would not match
// the products it skips, settings would overwrite the store's own), so they are
// reported as ignored and the message points at Restore.
const IGNORED_SECTIONS = {
	stockMovements: 'Lịch sử tồn kho không được gộp. Dùng "Khôi phục" để nạp lại toàn bộ lịch sử tồn kho.',
	settings: 'Cài đặt không được gộp để tránh ghi đè cài đặt hiện tại. Dùng "Khôi phục" để nạp lại cài đặt.'
};

const CHANNEL_SECTIONS = ['products', 'combos'];
// `publicCode` is importable so a restore keeps the links customers already
// shared; `slug` never is, it is recomputed from the name.
const CODE_SECTIONS = ['products', 'combos'];

const KNOWN_IMPORT_SECTIONS = [
	...Object.keys(IMPORT_WHITELIST),
	...Object.keys(REJECTED_SECTIONS),
	...Object.keys(IGNORED_SECTIONS)
];

/**
 * Keep only whitelisted keys from an untrusted record.
 *
 * `_id` gets special handling: it is accepted only when it is a well-formed
 * 24-hex ObjectId string (see F2 doc comment on IMPORT_WHITELIST above) — a
 * missing/malformed/forged `_id` is silently dropped, same as before this
 * field was ever whitelisted, and Mongo assigns a fresh one.
 *
 * `dropped` receives the name of every key of `obj` that was not carried over,
 * so the import can report what it left behind instead of hiding it.
 */
function pick(obj, allowed, dropped = []) {
	const out = {};
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) dropped.push(key);
	}
	for (const key of allowed) {
		if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
		if (key === '_id') {
			if (OBJECT_ID_RE.test(String(obj._id))) {
				out._id = obj._id;
			} else {
				dropped.push('_id');
			}
			continue;
		}
		out[key] = obj[key];
	}
	return out;
}

/**
 * Validate the whole import payload's shape before a single document is
 * written. A merge import is deliberately not one transaction: it adds what is
 * missing record by record, and one bad record must not block the rest. So the
 * only all-or-nothing gate is refusing to start when the structure itself is
 * broken. Per-record business validation (a bad price, a missing required
 * field) happens later, one record at a time, and is reported per collection.
 * (Restore is the all-or-nothing path.)
 */
function validateImportStructure(data) {
	const problems = [];
	const seenCodes = { products: new Set(), combos: new Set() };
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return ['"data" phải là một object'];
	}
	for (const [section, value] of Object.entries(data)) {
		if (!KNOWN_IMPORT_SECTIONS.includes(section)) {
			problems.push(`Không nhận diện được phần "${section}"`);
			continue;
		}
		if (!Array.isArray(value)) {
			problems.push(`Phần "${section}" phải là một mảng`);
			continue;
		}
		value.forEach((record, index) => {
			if (!record || typeof record !== 'object' || Array.isArray(record)) {
				problems.push(`Phần "${section}" tại vị trí ${index} không phải là một object hợp lệ`);
				return;
			}
			// Rejected up front, with the rest of the structure, so a bad value
			// never lets the import half-apply.
			if (CHANNEL_SECTIONS.includes(section) && record.salesChannel !== undefined
				&& !Product.SALES_CHANNELS.includes(record.salesChannel)) {
				problems.push(`Phần "${section}" tại vị trí ${index} có salesChannel không hợp lệ`);
			}
			if (CODE_SECTIONS.includes(section) && record.publicCode !== undefined) {
				if (typeof record.publicCode !== 'string' || !PUBLIC_CODE_PATTERN.test(record.publicCode)) {
					problems.push(`Phần "${section}" tại vị trí ${index} có publicCode không hợp lệ`);
				} else if (seenCodes[section].has(record.publicCode)) {
					problems.push(`Phần "${section}" tại vị trí ${index} có publicCode trùng trong file`);
				} else {
					seenCodes[section].add(record.publicCode);
				}
			}
		});
	}
	return problems;
}

function importErrorMessage(error, entity) {
	if (!isPublicCodeDuplicate(error)) return error.message;
	const code = error.keyValue && error.keyValue.publicCode;
	return `Mã công khai${code ? ` ${code}` : ''} đã thuộc ${entity} khác`;
}

/**
 * Export the business data as one v2 backup file
 * GET /api/admin/database/export
 * Admin authentication handled by parent router
 *
 * The file holds complete documents (ids, timestamps, every sub-array), the stock
 * ledger and the settings row, so a Restore can reproduce the store exactly.
 * Deliberately excludes users, accounts, sessions and jwks (Q7): this is a
 * business-data backup, so it never carries credential hashes or session and
 * provider tokens. The settings row holds the store's own bank display fields,
 * not credentials.
 */
router.get('/export', async (req, res) => {
	const correlationId = randomUUID();
	try {
		console.log(`[${new Date().toISOString()}] Database export requested by admin: ${req.user.email}`);

		const data = await dataSnapshot.exportAll();
		const metadata = buildMetadata(data, new Date());

		// Built in memory rather than streamed: the upload cap bounds every file a
		// restore can accept, so an export above it could never be restored. Refusing
		// here means an admin never downloads a backup that cannot be used.
		const body = JSON.stringify({ metadata, data });
		if (Buffer.byteLength(body) > limits.maxFileSize) {
			console.error(`[${correlationId}] Database export is ${Buffer.byteLength(body)} bytes, above the ${limits.maxFileSize} byte restore limit`);
			return sendCodedError(res, ERROR_CODES.EXPORT_TOO_LARGE, correlationId);
		}

		const filename = `database-export-${metadata.exportedAt.split('T')[0]}.json`;
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
		res.send(body);

		console.log(`[${new Date().toISOString()}] Database export completed:`, metadata.collections);
	} catch (error) {
		console.error(`[${correlationId}] Database export error:`, error);
		res.status(500).json({
			error: 'Export failed',
			code: 'EXPORT_ERROR',
			correlationId
		});
	}
});

/** Count one more skipped record, by the reason it was skipped. */
function countSkipped(result, reason) {
	result.skipped++;
	result.skippedByReason[reason] = (result.skippedByReason[reason] || 0) + 1;
}

/** Count, per field, how many imported records had that field left behind. */
function countDropped(droppedFields, section, keys) {
	for (const key of new Set(keys)) {
		droppedFields[section][key] = (droppedFields[section][key] || 0) + 1;
	}
}

/**
 * Merge business data from a JSON file: add what is missing, skip what exists,
 * never overwrite. Accepts v1 files and v2 backups; use Restore to replace.
 * POST /api/admin/database/import
 * Admin authentication handled by parent router
 */
router.post('/import', upload.single('dataFile'), gated(async (req, res) => {
	const correlationId = randomUUID();
	try {
		if (!req.file) {
			return res.status(400).json({
				error: 'No file uploaded',
				code: ERROR_CODES.NO_FILE,
				correlationId
			});
		}

		console.log(`[${new Date().toISOString()}] Database import started by admin: ${req.user.email}`);

		let importData;
		try {
			importData = JSON.parse(req.file.buffer.toString());
		} catch (parseError) {
			console.error(`[${correlationId}] Import JSON parse error:`, parseError.message);
			return res.status(400).json({
				error: 'Invalid JSON file',
				code: 'INVALID_JSON',
				correlationId
			});
		}

		if (!importData || typeof importData !== 'object' || Array.isArray(importData) || !importData.data) {
			return res.status(400).json({
				error: 'Invalid import data format',
				code: 'INVALID_FORMAT',
				correlationId
			});
		}

		const structureProblems = validateImportStructure(importData.data);
		if (structureProblems.length > 0) {
			console.error(`[${correlationId}] Import rejected before any write:`, structureProblems);
			return res.status(400).json({
				error: 'Invalid import data format',
				code: 'INVALID_FORMAT',
				problems: structureProblems,
				correlationId
			});
		}

		const { data } = importData;

		// users/accounts/sessions/jwks: never written, but the file is inspected
		// so the admin sees an explicit count instead of a silent "0 imported, 0 errors".
		const rejected = {};
		for (const [section, reason] of Object.entries(REJECTED_SECTIONS)) {
			if (Array.isArray(data[section]) && data[section].length > 0) {
				rejected[section] = { count: data[section].length, reason };
			}
		}
		const ignored = {};
		for (const [section, reason] of Object.entries(IGNORED_SECTIONS)) {
			if (Array.isArray(data[section]) && data[section].length > 0) {
				ignored[section] = { count: data[section].length, reason };
			}
		}

		const importResults = {};
		const errorDetails = {};
		const droppedFields = {};
		for (const section of Object.keys(IMPORT_WHITELIST)) {
			importResults[section] = { imported: 0, skipped: 0, errors: 0, skippedByReason: {} };
			errorDetails[section] = [];
			droppedFields[section] = {};
		}

		if (Array.isArray(data.products)) {
			for (let i = 0; i < data.products.length; i++) {
				const raw = data.products[i];
				try {
					const dropped = [];
					const picked = pick(raw, IMPORT_WHITELIST.products, dropped);
					const name = asString(raw.name, 200);
					if (picked._id && await Product.exists({ _id: picked._id })) {
						countSkipped(importResults.products, 'id_exists');
						continue;
					}
					if (name && await Product.exists({ name })) {
						countSkipped(importResults.products, 'name_exists');
						continue;
					}
					// The imported stock enters the ledger as its opening movement, in the
					// same transaction, so the cache stays equal to the sum of movements.
					// A publicCode collision aborts that transaction, so the retry wraps it.
					await withPublicCodeRetry(() => withTransaction(async (session) => {
						const [product] = await Product.create([picked], { session });
						if (product.stockQuantity !== 0) {
							await recordAppliedOpening(
								{ productId: product._id, quantity: product.stockQuantity, createdBy: req.user && req.user.email, reason: 'import' },
								{ session }
							);
						}
					}), { maxAttempts: picked.publicCode ? 1 : undefined });
					importResults.products.imported++;
					countDropped(droppedFields, 'products', dropped);
				} catch (error) {
					importResults.products.errors++;
					errorDetails.products.push({ index: i, error: importErrorMessage(error, 'sản phẩm') });
				}
			}
		}

		if (Array.isArray(data.combos)) {
			// Names are compared with the combos that existed before this import,
			// not with ones it adds: two same-name combos in one file both import.
			const namesBefore = new Set((await Combo.find({}, { name: 1 }).lean()).map((c) => c.name));
			for (let i = 0; i < data.combos.length; i++) {
				const raw = data.combos[i];
				try {
					const dropped = [];
					const picked = pick(raw, IMPORT_WHITELIST.combos, dropped);
					// The id decides first. Name is the fallback for files that carry no
					// usable id (v1) or an id from another environment, so those do not
					// duplicate a combo the store already has.
					if (picked._id && await Combo.exists({ _id: picked._id })) {
						countSkipped(importResults.combos, 'id_exists');
						continue;
					}
					const name = asString(raw.name, 100);
					if (name && namesBefore.has(name)) {
						countSkipped(importResults.combos, 'name_exists');
						continue;
					}
					await createWithPublicCodeRetry(Combo, picked);
					importResults.combos.imported++;
					countDropped(droppedFields, 'combos', dropped);
				} catch (error) {
					importResults.combos.errors++;
					errorDetails.combos.push({ index: i, error: importErrorMessage(error, 'combo') });
				}
			}
		}

		if (Array.isArray(data.orders)) {
			for (let i = 0; i < data.orders.length; i++) {
				const raw = data.orders[i];
				try {
					const orderCode = asString(raw.orderCode, 10);
					if (orderCode && await Order.exists({ orderCode })) {
						countSkipped(importResults.orders, 'order_code_exists');
						continue;
					}
					const dropped = [];
					const picked = pick(raw, IMPORT_WHITELIST.orders, dropped);

					// F1: a combo order's total is comboInfo.finalTotal + the
					// non-combo lines, never Σ(price × quantity) over every
					// line — see storedOrderTotal's doc comment.
					const total = storedOrderTotal(picked);
					if (total === null) {
						throw new Error('comboInfo.finalTotal không hợp lệ, không thể khôi phục tổng tiền đơn hàng combo');
					}
					picked.totalAmount = total;

					// Order.js's pre('save') hook only bumps statusUpdatedAt for
					// an existing document (`!this.isNew`), so on a fresh
					// `create()` the value passed in here already wins — no
					// follow-up write needed to preserve the original timestamp
					// through an export/import round-trip.
					await Order.create(picked);
					importResults.orders.imported++;
					countDropped(droppedFields, 'orders', dropped);
				} catch (error) {
					importResults.orders.errors++;
					errorDetails.orders.push({ index: i, error: error.message });
				}
			}
		}

		console.log(`[${new Date().toISOString()}] Database import completed:`, importResults);

		const hasErrors = Object.values(importResults).some(r => r.errors > 0);

		res.json({
			success: true,
			message: 'Database import completed',
			results: importResults,
			hasErrors,
			errorDetails: hasErrors ? errorDetails : undefined,
			rejected: Object.keys(rejected).length > 0 ? rejected : undefined,
			ignored: Object.keys(ignored).length > 0 ? ignored : undefined,
			droppedFields,
			metadata: {
				importDate: new Date().toISOString(),
				importedBy: req.user.email
			},
			correlationId
		});

	} catch (error) {
		console.error(`[${correlationId}] Database import error:`, error);
		res.status(500).json({
			error: 'Import failed',
			code: 'IMPORT_ERROR',
			correlationId
		});
	}
}));

/** Reply with the Vietnamese message of `code`, its status, and any detail lines. */
function sendCodedError(res, code, correlationId, problems) {
	const message = ERROR_MESSAGES[code].vi;
	return res.status(ERROR_CODE_TO_HTTP_STATUS[code]).json({
		error: message,
		message,
		code,
		problems,
		correlationId
	});
}

/** Thrown inside the restore transaction so that it rolls back. */
class StockMismatchError extends Error {
	constructor(mismatches) {
		super('Restored stock does not match the restored ledger');
		this.mismatches = mismatches;
	}
}

/**
 * Replace every product, combo, order, stock movement and the settings row with
 * the contents of a v2 backup file.
 * POST /api/admin/database/restore  (multipart: `dataFile`, `confirmation`)
 * Admin authentication handled by parent router
 *
 * Nothing is written until the whole file has passed validateSnapshot. The
 * delete and the reload are one transaction, and inside it the product stock
 * caches are compared with the restored ledger (`reconcile`, the same rule as
 * the admin stock page): a file whose cache and ledger disagree is refused and
 * nothing changes. Pending movements are handed to the queue only after the
 * commit.
 *
 * Totals and combo info are NOT recomputed here, unlike a merge import: this
 * reproduces the store's own history, and repricing an old order with today's
 * catalogue would rewrite what the customer actually paid. They are checked
 * for self-consistency instead (storedOrderTotal).
 */
router.post('/restore', upload.single('dataFile'), async (req, res) => {
	const correlationId = randomUUID();
	try {
		if (!req.body || req.body.confirmation !== RESTORE_CONFIRMATION) {
			return sendCodedError(res, ERROR_CODES.RESTORE_CONFIRMATION_REQUIRED, correlationId);
		}
		if (!req.file) {
			return sendCodedError(res, ERROR_CODES.NO_FILE, correlationId);
		}

		console.log(`[${new Date().toISOString()}] Database restore started by admin: ${req.user.email}`);

		let file;
		try {
			file = JSON.parse(req.file.buffer.toString());
		} catch (parseError) {
			console.error(`[${correlationId}] Restore JSON parse error:`, parseError.message);
			return sendCodedError(res, ERROR_CODES.RESTORE_FILE_INVALID, correlationId, ['File không phải JSON hợp lệ']);
		}
		if (!file || typeof file !== 'object' || Array.isArray(file) || !file.data) {
			return sendCodedError(res, ERROR_CODES.RESTORE_FILE_INVALID, correlationId, ['File thiếu "metadata" hoặc "data"']);
		}

		const formatVersion = file.metadata && file.metadata.formatVersion;
		if (formatVersion !== SNAPSHOT_FORMAT_VERSION) {
			const detail = formatVersion === undefined
				? 'Đây là file xuất theo định dạng cũ (không có lịch sử tồn kho và lịch sử đơn hàng đầy đủ). Hãy dùng Nhập Database để gộp dữ liệu.'
				: `Phiên bản định dạng ${String(formatVersion)} không được hỗ trợ (cần ${SNAPSHOT_FORMAT_VERSION}).`;
			return sendCodedError(res, ERROR_CODES.RESTORE_FORMAT_UNSUPPORTED, correlationId, [detail]);
		}

		const problems = validateSnapshot(file.metadata, file.data);
		if (problems.length > 0) {
			console.error(`[${correlationId}] Restore rejected before any write:`, problems);
			return sendCodedError(res, ERROR_CODES.RESTORE_FILE_INVALID, correlationId, problems);
		}

		// Closing the gate also makes restores run one at a time: a second close()
		// is refused. Orders and stock writes are held off and the running ones are
		// awaited, so none can be lost with the data being replaced.
		try {
			await closeWriteGate();
		} catch (gateError) {
			if (gateError instanceof WriteGateError) return sendCodedError(res, gateError.code, correlationId);
			throw gateError;
		}
		try {
			const restored = await withTransaction(async (tx) => {
				const written = await dataSnapshot.replaceAll(file.data, tx);
				const mismatches = await reconcile({ tx });
				if (mismatches.length > 0) throw new StockMismatchError(mismatches);
				return written;
			});

			// After the commit only: a queue call inside the transaction could be
			// repeated by a retry, and could not be undone by a rollback.
			// enqueueMovements logs and swallows queue failures (the sweeper re-enqueues
			// pending movements), so a committed restore never turns into a 500 here.
			const pendingIds = file.data.stockMovements.filter((m) => m.status === 'pending').map((m) => m._id);
			await enqueueMovements(pendingIds);

			console.log(`[${new Date().toISOString()}] Database restore completed by ${req.user.email}:`, restored);
			return res.json({
				ok: true,
				restored,
				message: 'Đã khôi phục dữ liệu từ bản sao lưu',
				correlationId
			});
		} finally {
			openWriteGate();
		}
	} catch (error) {
		if (error instanceof StockMismatchError) {
			const problems = error.mismatches.slice(0, 20).map(({ productId, name, cached, ledgerSum }) =>
				`${name} (${productId}): tồn kho ${cached}, lịch sử nhập xuất cho ${ledgerSum}`);
			return sendCodedError(res, ERROR_CODES.RESTORE_STOCK_MISMATCH, correlationId, problems);
		}
		if (isDuplicateKeyError(error)) {
			return sendCodedError(res, ERROR_CODES.RESTORE_FILE_INVALID, correlationId, [`File có giá trị trùng ở trường ${duplicateKeyFields(error)}`]);
		}
		console.error(`[${correlationId}] Database restore error:`, error);
		return sendCodedError(res, ERROR_CODES.RESTORE_ERROR, correlationId);
	}
});

/**
 * Get database statistics
 * GET /api/admin/database/stats
 * Admin authentication handled by parent router
 *
 * Counts, unlike /export, carry no PII or credential material, so users and
 * accounts stay in this response.
 */
router.get('/stats', async (req, res) => {
	try {
		const [userCount, productCount, orderCount, accountCount, comboCount] = await Promise.all([
			User.countDocuments({}),
			Product.countDocuments({}),
			Order.countDocuments({}),
			Account.countDocuments({}),
			Combo.countDocuments({})
		]);

		const stats = {
			collections: {
				users: userCount,
				products: productCount,
				orders: orderCount,
				accounts: accountCount,
				combos: comboCount,
				total: userCount + productCount + orderCount + accountCount + comboCount
			},
			lastUpdated: new Date().toISOString()
		};

		res.json(stats);
	} catch (error) {
		const correlationId = randomUUID();
		console.error(`[${correlationId}] Database stats error:`, error);
		res.status(500).json({
			error: 'Failed to get database statistics',
			code: 'STATS_ERROR',
			correlationId
		});
	}
});

// Multer throws its own errors (LIMIT_FILE_SIZE, the fileFilter rejection)
// from the upload.single() middleware itself, before either route handler's
// own try/catch ever runs — uncaught, those reached the global handler as a
// generic 500 instead of the explicit 400 every other rejection on this
// router returns (F10). Mirrors routes/upload.js's own handler. Mounted
// last so it only sees errors from the routes above.
router.use((err, req, res, next) => {
	if (err instanceof multer.MulterError) {
		const messages = {
			LIMIT_FILE_SIZE: `Kích thước file vượt quá giới hạn ${MAX_IMPORT_FILE_SIZE / (1024 * 1024)}MB`
		};
		return res.status(400).json({
			error: messages[err.code] || `Lỗi tải file: ${err.code}`,
			code: 'UPLOAD_ERROR'
		});
	}

	// fileFilter's rejection reaches here as a plain Error, not a MulterError.
	if (err && err.message === 'Only JSON files are allowed') {
		return res.status(400).json({
			error: 'Chỉ chấp nhận file JSON',
			code: 'INVALID_FILE_TYPE'
		});
	}

	next(err);
});

// Reachable from tests, which lower the export cap.
router.limits = limits;

module.exports = router;
