/**
 * Admin stock endpoints. Mounted by routes/admin.js, which already runs
 * authenticateAdmin in front of every router it mounts.
 *
 * Nothing here writes `Product.stockQuantity`: an adjustment is recorded as a
 * pending StockMovement and applied asynchronously by the ledger worker.
 */
const express = require('express');
const { randomUUID } = require('crypto');
const Product = require('../../models/Product');
const StockMovement = require('../../models/StockMovement');
const { asPageLimit } = require('../../utils/query-guard');
const { ERROR_CODES } = require('../../constants/errorCodes');
const { recordMovement, enqueueMovements, reconcile } = require('../../services/stock-ledger');

const router = express.Router();

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const MODES = ['delta', 'target'];
const MAX_REASON_LENGTH = 200;
// Far above any real stock count; only keeps sums well inside safe-integer range.
const MAX_ABS_VALUE = 1_000_000_000;

function invalid(res, message) {
	return res.status(400).json({ success: false, code: ERROR_CODES.STOCK_ADJUSTMENT_INVALID, message });
}

function parseAdjustment(body) {
	const { mode, value, reason } = body || {};
	if (!MODES.includes(mode)) return { error: 'Chế độ điều chỉnh không hợp lệ (delta hoặc target)' };
	if (!Number.isInteger(value) || Math.abs(value) > MAX_ABS_VALUE) return { error: 'Giá trị phải là số nguyên hợp lệ' };
	if (mode === 'delta' && value === 0) return { error: 'Số lượng thêm/bớt phải khác 0' };
	if (mode === 'target' && value < 0) return { error: 'Tồn kho đặt tới không được âm' };
	const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
	if (trimmedReason.length < 1 || trimmedReason.length > MAX_REASON_LENGTH) {
		return { error: `Lý do là bắt buộc (1-${MAX_REASON_LENGTH} ký tự)` };
	}
	return { mode, value, reason: trimmedReason };
}

/**
 * @route   POST /api/admin/products/:id/stock-adjustments
 * @body    { mode: 'delta' | 'target', value: integer, reason: string }
 * @desc    Add/remove N units, or set the stock to X. 202: recorded, applied shortly.
 */
router.post('/products/:id/stock-adjustments', async (req, res) => {
	try {
		const { id } = req.params;
		if (!OBJECT_ID_PATTERN.test(id)) return invalid(res, 'ID sản phẩm không hợp lệ');

		const parsed = parseAdjustment(req.body);
		if (parsed.error) return invalid(res, parsed.error);

		const exists = await Product.exists({ _id: id });
		if (!exists) {
			return res.status(404).json({ success: false, code: ERROR_CODES.NOT_FOUND, message: 'Không tìm thấy sản phẩm' });
		}

		const isTarget = parsed.mode === 'target';
		const movement = await recordMovement({
			productId: id,
			type: isTarget ? 'set_target' : 'adjust',
			delta: isTarget ? undefined : parsed.value,
			target: isTarget ? parsed.value : undefined,
			reason: parsed.reason,
			createdBy: req.user.email || req.user.name || String(req.user.id),
			// One per request: two deliberate adjustments must both count.
			idempotencyKey: `adjust:${id}:${randomUUID()}`
		});
		await enqueueMovements([movement]);

		res.status(202).json({ success: true, data: movement });
	} catch (error) {
		console.error('Stock adjustment error:', error);
		res.status(500).json({ success: false, code: ERROR_CODES.INTERNAL_SERVER_ERROR, message: 'Lỗi server khi điều chỉnh tồn kho' });
	}
});

/**
 * @route   GET /api/admin/products/:id/stock-movements?page&limit
 * @desc    Movement history of one product, newest first.
 */
router.get('/products/:id/stock-movements', async (req, res) => {
	try {
		const { id } = req.params;
		if (!OBJECT_ID_PATTERN.test(id)) {
			return res.status(400).json({ success: false, code: ERROR_CODES.VALIDATION_ERROR, message: 'ID sản phẩm không hợp lệ' });
		}

		const { page, limit } = asPageLimit(req.query.page, req.query.limit);
		const filter = { productId: id };
		const [items, total] = await Promise.all([
			StockMovement.find(filter)
				.sort({ createdAt: -1, _id: -1 })
				.skip((page - 1) * limit)
				.limit(limit)
				.select('type delta target stockAfter status reason createdBy orderId createdAt appliedAt')
				.lean(),
			StockMovement.countDocuments(filter)
		]);

		res.json({
			success: true,
			data: {
				items,
				pagination: { page, pages: Math.ceil(total / limit), total, limit }
			}
		});
	} catch (error) {
		console.error('Stock movements error:', error);
		res.status(500).json({ success: false, code: ERROR_CODES.INTERNAL_SERVER_ERROR, message: 'Lỗi server khi lấy lịch sử tồn kho' });
	}
});

/**
 * @route   GET /api/admin/stock/reconcile
 * @desc    Products whose cached stock differs from the sum of their applied movements.
 */
router.get('/stock/reconcile', async (req, res) => {
	try {
		res.json({ success: true, data: await reconcile() });
	} catch (error) {
		console.error('Stock reconcile error:', error);
		res.status(500).json({ success: false, code: ERROR_CODES.INTERNAL_SERVER_ERROR, message: 'Lỗi server khi đối soát tồn kho' });
	}
});

module.exports = router;
