const express = require('express');
const mongoose = require('mongoose');
const Order = require('../../models/Order');
const { validateOrderUpdate } = require('../../middleware/validation');
const { getPaginationInfo } = require('../../utils/helpers');
const { sendOrderToAppScript } = require('../../utils/appscript');
const { computeOrderPricing, PricingError } = require('../../services/pricing');
const { StockError, deductStockForItems, restoreStockForItems, applyStatusTransitionStockEffect } = require('../../services/stock');
const ErrorLogger = require('../../utils/errorLogger');
const { asEnum, asSort, safeSearch, asPageLimit } = require('../../utils/query-guard');
const router = express.Router();

const ORDER_STATUSES = ['confirmed', 'paid', 'delivered', 'cancelled'];
const ORDER_SORTABLE_FIELDS = ['createdAt', 'totalAmount', 'status', 'orderCode'];

const PRICING_ERROR_MESSAGES = {
	EMPTY_CART: 'Danh sách sản phẩm không hợp lệ',
	PRODUCT_UNAVAILABLE: 'Một hoặc nhiều sản phẩm không tồn tại hoặc không khả dụng',
	INVALID_QUANTITY: 'Số lượng sản phẩm không hợp lệ',
};

/**
 * @route   GET /api/admin/orders
 * @desc    Get all orders with pagination and search
 * @access  Private (Admin)
 */
router.get('/', async (req, res) => {
	try {
		const { page, limit, search, status, sortBy, sortOrder } = req.query;

		const statusFilter = asEnum(status, ORDER_STATUSES);
		const searchMatch = safeSearch(search);

		const query = {
			...(statusFilter && { status: statusFilter }),
			...(searchMatch && {
				$or: [
					{ orderCode: searchMatch },
					{ studentId: searchMatch },
					{ fullName: searchMatch },
					{ email: searchMatch }
				]
			})
		};

		const { page: pageNum, limit: limitNum } = asPageLimit(page, limit);
		const skip = (pageNum - 1) * limitNum;
		const sortOptions = asSort(sortBy, sortOrder, ORDER_SORTABLE_FIELDS);

		const [orders, total] = await Promise.all([
			Order.find(query)
				.sort(sortOptions)
				.skip(skip)
				.limit(limitNum)
				.lean(),
			Order.countDocuments(query)
		]);

		const pagination = getPaginationInfo(pageNum, limitNum, total);

		res.json({
			success: true,
			data: {
				orders,
				pagination
			}
		});

	} catch (error) {
		console.error('Error fetching orders:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy danh sách đơn hàng'
		});
	}
});

/**
 * @route   GET /api/admin/orders/:id
 * @desc    Get single order by ID
 * @access  Private (Admin)
 */
router.get('/:id', async (req, res) => {
	try {
		const order = await Order.findById(req.params.id);

		if (!order) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy đơn hàng'
			});
		}

		res.json({
			success: true,
			data: order
		});

	} catch (error) {
		console.error('Error fetching order:', error);

		if (error.name === 'CastError') {
			return res.status(400).json({
				success: false,
				message: 'ID đơn hàng không hợp lệ'
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thông tin đơn hàng'
		});
	}
});

/**
 * @route   PUT /api/admin/orders/:id
 * @desc    Update order status
 * @access  Private (Admin)
 *
 * Status transition is a single conditional update
 * (`findOneAndUpdate({_id, status: previousStatus}, ...)`): two admins
 * racing the same cancel both read the same previousStatus, but only one
 * write matches it — the loser gets `null` back and a 409, and never
 * touches stock. Only the request that actually won the transition performs
 * the stock side effect, so a cancel can never restore stock twice.
 */
router.put('/:id', validateOrderUpdate, async (req, res) => {
	const { id } = req.params;
	try {
		const { status, transactionCode, cancelReason, note } = req.body;

		const existing = await Order.findById(id).lean();
		if (!existing) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy đơn hàng'
			});
		}

		const previousStatus = existing.status;

		// Reject a transition to the order's own current status outright,
		// rather than letting it fall through to a same-value conditional
		// update that would trivially match and "succeed" again. Without
		// this, two admins racing the same cancel where the second request's
		// read happens to land *after* the first one's write (common outside
		// a perfectly simultaneous race, not just possible under it) would
		// both see 200 — the second one silently re-cancelling an
		// already-cancelled order — instead of the second one being told
		// nothing was left to do.
		if (status === previousStatus) {
			return res.status(409).json({
				success: false,
				message: 'Đơn hàng đã ở trạng thái này'
			});
		}

		const historyEntry = {
			status,
			updatedAt: new Date(),
			updatedBy: req.admin.username
		};
		const setFields = {
			status,
			statusUpdatedAt: new Date(),
			lastUpdatedBy: req.admin.username
		};

		if (status === 'paid' && transactionCode) {
			setFields.transactionCode = transactionCode;
			historyEntry.transactionCode = transactionCode;
		}
		if (status === 'cancelled' && cancelReason) {
			setFields.cancelReason = cancelReason;
			historyEntry.cancelReason = cancelReason;
		}
		if (note) {
			historyEntry.note = note;
		}

		const transitioned = await Order.findOneAndUpdate(
			{ _id: id, status: previousStatus },
			{ $set: setFields, $push: { statusHistory: historyEntry } },
			{ new: true, runValidators: true }
		);

		if (!transitioned) {
			return res.status(409).json({
				success: false,
				message: 'Đơn hàng vừa được người khác cập nhật, vui lòng tải lại và thử lại'
			});
		}

		// Stock side effect for the winning request only — see
		// services/stock.js#applyStatusTransitionStockEffect for the rules
		// (restore on cancel iff stock was deducted; re-deduct on un-cancel
		// iff this is a direct sale that currently has no deduction).
		try {
			const newStockDeducted = await applyStatusTransitionStockEffect({
				items: transitioned.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
				isDirectSale: transitioned.isDirectSale,
				stockDeducted: transitioned.stockDeducted,
				previousStatus,
				newStatus: status
			});

			if (newStockDeducted !== null) {
				await Order.updateOne({ _id: id }, { $set: { stockDeducted: newStockDeducted } });
				transitioned.stockDeducted = newStockDeducted;
			}
		} catch (stockErr) {
			// The status transition already committed; since there is no
			// replica set / transaction to roll both writes back together,
			// best-effort revert the status so the order doesn't end up
			// claiming a status its stock state cannot support. The
			// conditional match protects this from racing a concurrent
			// change to the same order.
			await Order.updateOne(
				{ _id: id, status },
				{ $set: { status: previousStatus, statusUpdatedAt: new Date() }, $pop: { statusHistory: 1 } }
			);

			if (stockErr instanceof StockError && stockErr.code === 'INSUFFICIENT_STOCK') {
				return res.status(400).json({
					success: false,
					message: 'Không đủ hàng trong kho để khôi phục đơn hàng này',
					details: stockErr.details
				});
			}

			ErrorLogger.logCritical('Cập nhật kho thất bại khi đổi trạng thái đơn hàng', stockErr, { orderId: id, previousStatus, status });
			return res.status(500).json({
				success: false,
				message: 'Lỗi khi cập nhật kho hàng'
			});
		}

		// Tự động push lên App Script mỗi lần cập nhật trạng thái
		const appscriptData = {
			orderCode: transitioned.orderCode,
			studentId: transitioned.studentId,
			fullName: transitioned.fullName,
			email: transitioned.email,
			additionalNote: transitioned.additionalNote,
			items: transitioned.items,
			totalAmount: transitioned.totalAmount,
			transactionCode: transitioned.transactionCode,
			cancelReason: transitioned.cancelReason,
			status: transitioned.status
		};
		console.log('Push to AppScript:', appscriptData);
		setImmediate(() => {
			sendOrderToAppScript(appscriptData).catch(err => {
				console.error('AppScript push error:', err.message);
			});
		});

		res.json({
			success: true,
			message: 'Cập nhật trạng thái đơn hàng thành công',
			data: transitioned
		});

	} catch (error) {
		console.error('Error updating order:', error);

		if (error.name === 'CastError') {
			return res.status(400).json({
				success: false,
				message: 'ID đơn hàng không hợp lệ'
			});
		}

		if (error.name === 'ValidationError') {
			const errorMessages = Object.values(error.errors).map(err => err.message);
			return res.status(400).json({
				success: false,
				message: errorMessages.join(', ')
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi cập nhật đơn hàng'
		});
	}
});

/**
 * @route   DELETE /api/admin/orders
 * @desc    Delete all orders (DANGEROUS - Admin only)
 * @access  Private (Admin)
 */
router.delete('/', async (req, res) => {
	try {
		console.log('🚨 DELETE ALL ORDERS Request:', {
			admin: req.admin.username,
			timestamp: new Date().toISOString(),
			userAgent: req.get('User-Agent')
		});

		// Count total orders before deletion for reporting
		const totalCount = await Order.countDocuments();

		if (totalCount === 0) {
			return res.json({
				success: true,
				message: 'Không có đơn hàng nào để xóa',
				data: {
					deletedCount: 0,
					totalCount: 0
				}
			});
		}

		console.log(`📊 Found ${totalCount} orders to delete`);

		// Perform bulk deletion
		const result = await Order.deleteMany({});

		console.log('✅ Bulk deletion completed:', {
			deletedCount: result.deletedCount,
			acknowledged: result.acknowledged,
			admin: req.admin.username
		});

		// Log the dangerous operation
		console.warn('🔥 CRITICAL OPERATION - ALL ORDERS DELETED:', {
			deletedCount: result.deletedCount,
			performedBy: req.admin.username,
			timestamp: new Date().toISOString(),
			originalTotal: totalCount
		});

		res.json({
			success: true,
			message: `Đã xóa thành công ${result.deletedCount} đơn hàng`,
			data: {
				deletedCount: result.deletedCount,
				totalCount: totalCount,
				performedBy: req.admin.username,
				timestamp: new Date().toISOString()
			}
		});

	} catch (error) {
		console.error('💥 Error deleting all orders:', error);

		// Log the failed dangerous operation
		console.error('🔥 CRITICAL OPERATION FAILED - DELETE ALL ORDERS:', {
			error: error.message,
			admin: req.admin.username,
			timestamp: new Date().toISOString()
		});

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi xóa đơn hàng',
			error: process.env.NODE_ENV === 'development' ? error.message : undefined
		});
	}
});

/**
 * Generate a direct-sale order code that has not been used yet. Only checks
 * for a pre-existing collision; the caller must still handle E11000 on
 * save() for the narrower race between this check and the insert.
 */
async function generateUniqueDirectOrderCode() {
	for (let attempt = 0; attempt < 10; attempt++) {
		const orderCode = `AD${String(Math.floor(Math.random() * 900000) + 100000)}`; // AD100000-AD999999
		// eslint-disable-next-line no-await-in-loop
		const existing = await Order.findOne({ orderCode }).lean();
		if (!existing) return orderCode;
	}
	return null;
}

/**
 * @route   POST /api/admin/orders/direct
 * @desc    Create direct sale order (admin)
 * @access  Private (Admin)
 *
 * Rewritten for Q2: the previous version cast `createdBy` from
 * `req.admin.username` (a String) into the schema's ObjectId field, so
 * `order.save()` threw a CastError on every single call — the route never
 * produced an order. It also declared `fullName` twice in the same object
 * literal (the second silently won), generated `orderCode` from
 * `countDocuments() + 1` (a duplicate-key race under any concurrent calls),
 * and set `status: 'paid'` without ever deducting stock — the exact
 * asymmetric accounting this phase closes everywhere else.
 */
router.post('/direct', async (req, res) => {
	try {
		const { items } = req.body;

		if (!items || !Array.isArray(items) || items.length === 0) {
			return res.status(400).json({
				success: false,
				message: 'Danh sách sản phẩm không được để trống'
			});
		}

		let totalAmount, orderItems, comboInfo;
		try {
			({ totalAmount, orderItems, comboInfo } = await computeOrderPricing(items));
		} catch (pricingError) {
			if (pricingError instanceof PricingError) {
				return res.status(pricingError.httpStatus).json({
					success: false,
					message: PRICING_ERROR_MESSAGES[pricingError.code] || 'Không thể tính giá đơn hàng',
					...(Object.keys(pricingError.details || {}).length > 0 && { details: pricingError.details })
				});
			}
			throw pricingError;
		}

		// Deduct stock before persisting the order — a mid-loop failure
		// (insufficient stock on a later line) compensates every line already
		// deducted, so a rejected direct sale never leaves stock short.
		try {
			await deductStockForItems(
				orderItems.map((item) => ({ productId: item.productId, quantity: item.quantity }))
			);
		} catch (stockErr) {
			if (stockErr instanceof StockError && stockErr.code === 'INSUFFICIENT_STOCK') {
				return res.status(400).json({
					success: false,
					message: 'Không đủ hàng trong kho cho đơn bán trực tiếp này',
					details: stockErr.details
				});
			}
			throw stockErr;
		}

		const createdBy = mongoose.Types.ObjectId.isValid(req.admin?.id) ? req.admin.id : null;

		let order;
		let attempts = 0;
		const maxAttempts = 10;
		try {
			while (!order) {
				attempts++;
				if (attempts > maxAttempts) {
					throw Object.assign(new Error('ORDER_CODE_EXHAUSTED'), { code: 'ORDER_CODE_EXHAUSTED' });
				}

				const orderCode = await generateUniqueDirectOrderCode();
				if (!orderCode) continue;

				try {
					order = await new Order({
						orderCode,
						fullName: `NB: ${req.admin.username}`,
						items: orderItems,
						totalAmount,
						status: 'paid',
						isDirectSale: true,
						stockDeducted: true,
						createdBy,
						lastUpdatedBy: req.admin.username,
						comboInfo,
						statusHistory: [{
							status: 'paid',
							updatedAt: new Date(),
							updatedBy: req.admin.username,
							note: 'Bán trực tiếp tại cửa hàng'
						}]
					}).save();
				} catch (saveError) {
					if (saveError.code === 11000) continue; // orderCode collision, retry
					throw saveError;
				}
			}
		} catch (orderCreationError) {
			// Order never persisted — compensate the stock deducted above so a
			// failed direct sale (code exhaustion, unexpected save error)
			// never leaves stock permanently short.
			await restoreStockForItems(
				orderItems.map((item) => ({ productId: item.productId, quantity: item.quantity }))
			).catch((compensationError) => {
				ErrorLogger.logCritical('Bù kho thất bại sau khi tạo đơn bán trực tiếp (admin) thất bại', compensationError, { orderItems });
			});

			if (orderCreationError.code === 'ORDER_CODE_EXHAUSTED') {
				return res.status(500).json({
					success: false,
					message: 'Không thể tạo mã đơn hàng duy nhất sau nhiều lần thử'
				});
			}
			throw orderCreationError;
		}

		res.status(201).json({
			success: true,
			message: 'Tạo đơn hàng bán trực tiếp thành công',
			data: {
				order,
				orderCode: order.orderCode,
				totalAmount
			}
		});

	} catch (error) {
		console.error('💥 Direct order creation error:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi tạo đơn hàng'
		});
	}
});

module.exports = router;
