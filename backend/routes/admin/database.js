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
const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: 10 * 1024 * 1024 // 10MB limit
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
 * `_id`, `createdAt` and `updatedAt` are absent from every whitelist on
 * purpose: Mongoose assigns a fresh `_id` on `.create()` and manages
 * timestamps itself when the field is left out, so an imported record can
 * never pin an identity or fabricate a history.
 *
 * `orders` also excludes `totalAmount` — Phase 05 closed the hole where a
 * client sets its own order total; accepting it from a restore file would
 * reopen exactly that hole. The total is recomputed from the (whitelisted)
 * `items` array by computeOrderTotal() instead of trusted from the file.
 */
const IMPORT_WHITELIST = {
	products: [
		'name', 'description', 'price', 'imageUrl', 'category', 'available',
		'isActive', 'stockQuantity', 'minOrderQuantity', 'maxOrderQuantity',
		'sku', 'tags', 'weight', 'dimensions', 'featured', 'salePrice',
		'saleStartDate', 'saleEndDate'
	],
	combos: ['name', 'description', 'price', 'categoryRequirements', 'isActive', 'priority'],
	orders: [
		'phoneNumber', 'orderCode', 'orderNumber', 'studentId', 'fullName', 'email',
		'additionalNote', 'items', 'status', 'transactionCode', 'cancelReason',
		'lastUpdatedBy', 'isDirectSale', 'comboInfo', 'statusUpdatedAt'
	]
};

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

/** Keep only whitelisted keys from an untrusted record. */
function pick(obj, allowed) {
	const out = {};
	for (const key of allowed) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			out[key] = obj[key];
		}
	}
	return out;
}

/** Sum item price * quantity — the only trustworthy source for an order's total. */
function computeOrderTotal(items) {
	if (!Array.isArray(items)) return 0;
	return items.reduce((sum, item) => {
		const price = Number(item?.price) || 0;
		const quantity = Number(item?.quantity) || 0;
		return sum + price * quantity;
	}, 0);
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
					picked.totalAmount = computeOrderTotal(picked.items);
					const created = await Order.create(picked);
					// Order.js's pre('save') hook (owned by Phase 06) stamps
					// statusUpdatedAt to "now" on every create because the status
					// path is always modified on a new document — round-tripping
					// through export/import would otherwise silently erase the
					// original timestamp. Bypass the hook with a direct update.
					if (picked.statusUpdatedAt) {
						await Order.updateOne(
							{ _id: created._id },
							{ $set: { statusUpdatedAt: picked.statusUpdatedAt } }
						);
					}
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

module.exports = router;
