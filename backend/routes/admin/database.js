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

const router = express.Router();

// Configure multer for file uploads.
// 10MB, down from the previous 50MB: JSON.parse on the whole buffer plus the
// in-memory multer buffer itself means peak transient memory is roughly 5x
// the file size, and this endpoint has no legitimate reason to restore a file
// larger than the business data (products/combos/orders) could ever produce.
// frontend/nginx.conf's `/api/admin/database/import` location must stay at
// or above this limit (F10) — nginx previously allowed 50M for a route that
// has only ever accepted 10M at the multer layer, so an oversized file failed
// with a generic 500 instead of the explicit 413/400 nginx or the handler
// below now produce.
const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024; // 10MB

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
 * Only these fields can be written by an imported record.
 *
 * `createdAt`/`updatedAt` are absent from every whitelist on purpose:
 * Mongoose manages timestamps itself when the field is left out, so an
 * imported record can never fabricate a history.
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
 * `orders` excludes both `_id` (nothing else references an order's own id)
 * and `totalAmount` — Phase 05 closed the hole where a client sets its own
 * order total; accepting it from a restore file would reopen exactly that
 * hole. The total is recomputed from the (whitelisted) `items` array by
 * computeOrderTotal()/computeOrderTotalWithCombo() instead of trusted from
 * the file.
 */
const IMPORT_WHITELIST = {
	products: [
		'_id', 'name', 'description', 'price', 'imageUrl', 'category', 'available',
		'isActive', 'stockQuantity', 'minOrderQuantity', 'maxOrderQuantity',
		'sku', 'tags', 'weight', 'dimensions', 'featured', 'salePrice',
		'saleStartDate', 'saleEndDate'
	],
	combos: ['_id', 'name', 'description', 'price', 'categoryRequirements', 'isActive', 'priority'],
	orders: [
		'phoneNumber', 'orderCode', 'orderNumber', 'studentId', 'fullName', 'email',
		'additionalNote', 'items', 'status', 'transactionCode', 'cancelReason',
		'lastUpdatedBy', 'isDirectSale', 'comboInfo', 'statusUpdatedAt'
	]
};

/** A 24-char hex string — the only shape `JSON.stringify`d ObjectId export produces. */
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// users and accounts are never imported, full stop — restoring credential
// material is mongodump/mongorestore's job at the operational layer, not this
// HTTP endpoint's. A file that includes either section is not silently
// dropped: its record count is reported back so an admin restoring from a
// real backup notices the gap instead of being told "0 errors".
const REJECTED_SECTIONS = {
	users: 'Người dùng không thể import qua file vì lý do bảo mật. Tạo tài khoản qua giao diện quản trị.',
	accounts: 'Tài khoản đăng nhập không thể import qua file vì lý do bảo mật. Tạo tài khoản qua giao diện quản trị.'
};

const KNOWN_IMPORT_SECTIONS = [...Object.keys(IMPORT_WHITELIST), ...Object.keys(REJECTED_SECTIONS)];

/**
 * Keep only whitelisted keys from an untrusted record.
 *
 * `_id` gets special handling: it is accepted only when it is a well-formed
 * 24-hex ObjectId string (see F2 doc comment on IMPORT_WHITELIST above) — a
 * missing/malformed/forged `_id` is silently dropped, same as before this
 * field was ever whitelisted, and Mongo assigns a fresh one.
 */
function pick(obj, allowed) {
	const out = {};
	for (const key of allowed) {
		if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
		if (key === '_id') {
			if (OBJECT_ID_RE.test(String(obj._id))) {
				out._id = obj._id;
			}
			continue;
		}
		out[key] = obj[key];
	}
	return out;
}

/** Sum item price * quantity — the only trustworthy source for a non-combo order's total. */
function computeOrderTotal(items) {
	if (!Array.isArray(items)) return 0;
	return items.reduce((sum, item) => {
		const price = Number(item?.price) || 0;
		const quantity = Number(item?.quantity) || 0;
		return sum + price * quantity;
	}, 0);
}

/**
 * Total for an order whose `comboInfo` is present (F1).
 *
 * `services/pricing.js:198-210` documents the contract every combo order is
 * created under: combo lines (`items[].fromCombo === true`) keep their
 * original per-unit price for display, and the combo's actual contribution
 * to `totalAmount` is `comboInfo.finalTotal`, not Σ(price × quantity) over
 * those lines — that sum double-counts the combo's own discount away.
 * `computeOrderTotal()` alone therefore inflates a combo order's restored
 * total by exactly the combo's savings.
 *
 * This mirrors pricing.js's own formula (`comboInfo.finalTotal` + Σ of only
 * the non-combo lines) rather than trusting the file's `totalAmount`
 * outright: a genuine export was itself produced by that exact formula, so
 * recomputing it here reproduces the original total exactly (round-trips),
 * while a corrupted/hand-edited `comboInfo.finalTotal` still gets caught
 * instead of silently accepted.
 *
 * @returns {number|null} null when comboInfo.finalTotal is missing/not a
 *          finite number — the caller reports that record as an error
 *          instead of importing a bogus total.
 */
function computeOrderTotalWithCombo(items, comboInfo) {
	const finalTotal = Number(comboInfo?.finalTotal);
	if (!Number.isFinite(finalTotal)) return null;
	const nonComboItems = Array.isArray(items) ? items.filter((item) => !item?.fromCombo) : [];
	return finalTotal + computeOrderTotal(nonComboItems);
}

/**
 * Validate the whole import payload's shape before a single document is
 * written. An import file is not run under a Mongo transaction (this
 * deployment is not a replica set — see AD-4 in the parent plan), so the only
 * atomicity guarantee available is refusing to start when the structure
 * itself is broken. Per-record business validation (a bad price, a missing
 * required field) still happens later, one record at a time, and is reported
 * per collection rather than aborting the whole restore.
 */
function validateImportStructure(data) {
	const problems = [];
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
			}
		});
	}
	return problems;
}

/** Write one collection as a JSON array using a cursor so the whole result set is never held in memory at once. */
async function streamCollectionArray(res, name, cursor) {
	res.write(`"${name}":[`);
	let first = true;
	for await (const doc of cursor) {
		if (!first) res.write(',');
		res.write(JSON.stringify(doc));
		first = false;
	}
	res.write(']');
}

/**
 * Export business data as JSON
 * GET /api/admin/database/export
 * Admin authentication handled by parent router
 *
 * Deliberately excludes `users` and `accounts` (Q7): this export is a
 * business-data backup (products/combos/orders), not a full-system restore
 * point, so it never carries credential hashes or session/provider tokens.
 * Full-system backups belong to mongodump at the operational layer.
 */
router.get('/export', async (req, res) => {
	const correlationId = randomUUID();
	try {
		console.log(`[${new Date().toISOString()}] Database export requested by admin: ${req.user.email}`);

		const [productCount, comboCount, orderCount] = await Promise.all([
			Product.countDocuments({}),
			Combo.countDocuments({}),
			Order.countDocuments({})
		]);

		const filename = `database-export-${new Date().toISOString().split('T')[0]}.json`;
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

		const metadata = {
			exportDate: new Date().toISOString(),
			exportedBy: req.user.email,
			version: '2.0',
			collections: { products: productCount, combos: comboCount, orders: orderCount }
		};

		res.write('{');
		res.write(`"metadata":${JSON.stringify(metadata)},`);
		res.write('"data":{');
		await streamCollectionArray(res, 'products', Product.find({}).lean().cursor());
		res.write(',');
		await streamCollectionArray(res, 'combos', Combo.find({}).lean().cursor());
		res.write(',');
		await streamCollectionArray(res, 'orders', Order.find({}).lean().cursor());
		res.write('}}');
		res.end();

		console.log(`[${new Date().toISOString()}] Database export completed: products ${productCount}, combos ${comboCount}, orders ${orderCount}`);
	} catch (error) {
		console.error(`[${correlationId}] Database export error:`, error);
		if (res.headersSent) {
			// Streaming had already begun — valid JSON can no longer be produced,
			// so end the connection instead of appending a second, malformed
			// error payload after a truncated document.
			res.end();
			return;
		}
		res.status(500).json({
			error: 'Export failed',
			code: 'EXPORT_ERROR',
			correlationId
		});
	}
});

/**
 * Import business data from a JSON file
 * POST /api/admin/database/import
 * Admin authentication handled by parent router
 */
router.post('/import', upload.single('dataFile'), async (req, res) => {
	const correlationId = randomUUID();
	try {
		if (!req.file) {
			return res.status(400).json({
				error: 'No file uploaded',
				code: 'NO_FILE',
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

		// users/accounts: never written, but the file is inspected so the admin
		// sees an explicit count instead of a silent "0 imported, 0 errors".
		const rejected = {};
		for (const [section, reason] of Object.entries(REJECTED_SECTIONS)) {
			if (Array.isArray(data[section]) && data[section].length > 0) {
				rejected[section] = { count: data[section].length, reason };
			}
		}

		const importResults = {};
		const errorDetails = {};
		for (const section of Object.keys(IMPORT_WHITELIST)) {
			importResults[section] = { imported: 0, skipped: 0, errors: 0 };
			errorDetails[section] = [];
		}

		if (Array.isArray(data.products)) {
			for (let i = 0; i < data.products.length; i++) {
				const raw = data.products[i];
				try {
					const name = asString(raw.name, 200);
					const existing = name ? await Product.findOne({ name }) : null;
					if (existing) {
						importResults.products.skipped++;
						continue;
					}
					await Product.create(pick(raw, IMPORT_WHITELIST.products));
					importResults.products.imported++;
				} catch (error) {
					importResults.products.errors++;
					errorDetails.products.push({ index: i, error: error.message });
				}
			}
		}

		if (Array.isArray(data.combos)) {
			for (let i = 0; i < data.combos.length; i++) {
				const raw = data.combos[i];
				try {
					const name = asString(raw.name, 100);
					const existing = name ? await Combo.findOne({ name }) : null;
					if (existing) {
						importResults.combos.skipped++;
						continue;
					}
					await Combo.create(pick(raw, IMPORT_WHITELIST.combos));
					importResults.combos.imported++;
				} catch (error) {
					importResults.combos.errors++;
					errorDetails.combos.push({ index: i, error: error.message });
				}
			}
		}

		if (Array.isArray(data.orders)) {
			for (let i = 0; i < data.orders.length; i++) {
				const raw = data.orders[i];
				try {
					const orderCode = asString(raw.orderCode, 10);
					const existing = orderCode ? await Order.findOne({ orderCode }) : null;
					if (existing) {
						importResults.orders.skipped++;
						continue;
					}
					const picked = pick(raw, IMPORT_WHITELIST.orders);

					// F1: a combo order's total is comboInfo.finalTotal + the
					// non-combo lines, never Σ(price × quantity) over every
					// line — see computeOrderTotalWithCombo's doc comment.
					if (picked.comboInfo) {
						const comboTotal = computeOrderTotalWithCombo(picked.items, picked.comboInfo);
						if (comboTotal === null) {
							throw new Error('comboInfo.finalTotal không hợp lệ, không thể khôi phục tổng tiền đơn hàng combo');
						}
						picked.totalAmount = comboTotal;
					} else {
						picked.totalAmount = computeOrderTotal(picked.items);
					}

					// Order.js's pre('save') hook only bumps statusUpdatedAt for
					// an existing document (`!this.isNew`), so on a fresh
					// `create()` the value passed in here already wins — no
					// follow-up write needed to preserve the original timestamp
					// through an export/import round-trip.
					await Order.create(picked);
					importResults.orders.imported++;
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

module.exports = router;
