const express = require('express');
const { ORDER_STATUSES } = require('@sab/shared');
const { orders } = require('../../data');
const { InvalidIdError, RecordValidationError } = require('../../data/errors');
const { ERROR_CODES, ERROR_MESSAGES } = require('../../constants/errorCodes');
const { validateOrderUpdate, validateOrderNotes, validateOrderItemsEdit, trimText, trimStatusText } = require('../../middleware/validation');
const { editOrderItems } = require('../../services/order-edit');
const { PricingError, pricingErrorBody } = require('../../services/pricing');
const { sendOrderToAppScript } = require('../../utils/appscript');
const { sendOrderMail } = require('../../services/mailer');
const { transitionOrderWithStock } = require('../../services/stock');
const { enqueueMovements } = require('../../services/stock-ledger');
const { gated } = require('../../services/write-gate');
const { asEnum, asSort, asPageLimit } = require('../../utils/query-guard');
const ErrorLogger = require('../../utils/errorLogger');
const router = express.Router();

const ORDER_SORTABLE_FIELDS = ['createdAt', 'totalAmount', 'status', 'orderCode'];
const SEARCH_FIELDS = ['orderCode', 'studentId', 'fullName', 'email'];

/**
 * @route   GET /api/admin/orders
 * @desc    Get all orders with pagination and search
 * @access  Private (Admin)
 */
router.get('/', async (req, res) => {
	try {
		const { page, limit, search, status, sortBy, sortOrder } = req.query;

		const { data, meta } = await orders.listPage({
			...asPageLimit(page, limit),
			sort: asSort(sortBy, sortOrder, ORDER_SORTABLE_FIELDS),
			status: asEnum(status, ORDER_STATUSES),
			search,
			searchFields: SEARCH_FIELDS,
			omit: ['itemsHistory']
		});

		res.json({ success: true, data, meta });

	} catch (error) {
		ErrorLogger.log(error, { route: 'GET /admin/orders' });
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
		const order = await orders.findDetail(req.params.id, { complete: true });

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
		ErrorLogger.log(error, { route: 'GET /admin/orders/:id' });

		if (error instanceof InvalidIdError) {
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
 * Cancelled and delivered orders are final and refuse any status change.
 */
router.put('/:id', validateOrderUpdate, gated(async (req, res) => {
	const { id } = req.params;
	try {
		const { status } = req.body;
		const { transactionCode, cancelReason, note } = trimStatusText(req.body);

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

		// Status and stock movement commit together (see transitionOrderWithStock).
		// A same-status request is refused rather than re-applied, so the second of
		// two racing cancels is told nothing was left to do.
		const result = await transitionOrderWithStock({
			orderId: id,
			status,
			setFields,
			historyEntry,
			actor: req.admin.username
		});

		if (result.outcome === 'not_found') {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy đơn hàng'
			});
		}
		if (result.outcome === 'final') {
			return res.status(409).json({
				success: false,
				code: ERROR_CODES.ORDER_FINAL,
				message: ERROR_MESSAGES[ERROR_CODES.ORDER_FINAL].vi
			});
		}
		if (result.outcome === 'unchanged') {
			return res.status(409).json({
				success: false,
				message: 'Đơn hàng đã ở trạng thái này'
			});
		}
		if (result.outcome === 'conflict') {
			return res.status(409).json({
				success: false,
				message: 'Đơn hàng vừa được người khác cập nhật, vui lòng tải lại và thử lại'
			});
		}

		await enqueueMovements(result.movements);
		const transitioned = result.order;

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
		setImmediate(() => {
			sendOrderToAppScript(appscriptData).catch(err => {
				console.error('AppScript push error:', err.message);
			});
		});

		// Only a real transition reaches here (the refusals above returned already).
		setImmediate(() => {
			sendOrderMail('status_changed', transitioned);
		});

		res.json({
			success: true,
			message: 'Cập nhật trạng thái đơn hàng thành công',
			data: transitioned
		});

	} catch (error) {
		ErrorLogger.log(error, { route: 'PUT /admin/orders/:id' });

		if (error instanceof InvalidIdError) {
			return res.status(400).json({
				success: false,
				message: 'ID đơn hàng không hợp lệ'
			});
		}

		if (error instanceof RecordValidationError) {
			return res.status(400).json({
				success: false,
				message: error.message
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi cập nhật đơn hàng'
		});
	}
}));

/**
 * @route   PUT /api/admin/orders/:id/items
 * @desc    Replace the products of a confirmed/paid order without changing its total
 * @access  Private (Admin)
 *
 * The total is a rule enforced in services/order-edit.js, not something this
 * route reads from the request. Nothing is pushed to App Script: the sheet is
 * keyed by order code and this repo cannot tell whether a resend would overwrite
 * the row or append another, so `itemsHistory` is the record of the change.
 */
router.put('/:id/items', validateOrderItemsEdit, gated(async (req, res) => {
	try {
		const { items } = req.body;

		// Validation does not rewrite the request, but the service needs numbers and the trimmed reason.
		const result = await editOrderItems({
			orderId: req.params.id,
			items: items.map(({ productId, quantity }) => ({ productId, quantity: Number(quantity) })),
			expectedRevision: Number(req.body.expectedRevision),
			reason: trimText(req.body.reason),
			actor: req.admin.username
		});

		switch (result.outcome) {
			case 'not_found':
				return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' });
			case 'final':
				return res.status(409).json({
					success: false,
					code: ERROR_CODES.ORDER_FINAL,
					message: ERROR_MESSAGES[ERROR_CODES.ORDER_FINAL].vi
				});
			case 'changed':
				return res.status(409).json({
					success: false,
					code: ERROR_CODES.ORDER_CHANGED,
					message: ERROR_MESSAGES[ERROR_CODES.ORDER_CHANGED].vi
				});
			case 'total_changed':
				return res.status(409).json({
					success: false,
					code: ERROR_CODES.ORDER_TOTAL_CHANGED,
					message: ERROR_MESSAGES[ERROR_CODES.ORDER_TOTAL_CHANGED].vi,
					details: { expected: result.expected, actual: result.actual }
				});
			case 'unchanged':
				return res.json({ success: true, unchanged: true, data: result.order });
			default:
				break;
		}

		// The edit is durable; only now may stock work be queued.
		await enqueueMovements(result.movements);

		res.json({
			success: true,
			message: 'Cập nhật sản phẩm trong đơn hàng thành công',
			data: result.order
		});

	} catch (error) {
		if (error instanceof PricingError) {
			return res.status(error.httpStatus).json(pricingErrorBody(error));
		}
		if (error instanceof InvalidIdError) {
			return res.status(400).json({ success: false, message: 'ID đơn hàng không hợp lệ' });
		}
		ErrorLogger.log(error, { route: 'PUT /admin/orders/:id/items' });
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi sửa sản phẩm trong đơn hàng'
		});
	}
}));

/**
 * @route   PATCH /api/admin/orders/:id/notes
 * @desc    Edit the customer note and/or append an internal note
 * @access  Private (Admin)
 *
 * Allowed in every status, final ones included: notes touch neither status nor
 * stock, so one conditional-free update is enough and nothing goes to App Script.
 */
router.patch('/:id/notes', validateOrderNotes, gated(async (req, res) => {
	try {
		const additionalNote = trimText(req.body.additionalNote);
		const note = trimText(req.body.note);

		const order = await orders.updateNotes({
			orderId: req.params.id,
			additionalNote,
			...(note !== undefined && { internalNote: { note, by: req.admin.username, at: new Date() } })
		});

		if (!order) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy đơn hàng'
			});
		}

		res.json({
			success: true,
			message: 'Cập nhật ghi chú thành công',
			data: order
		});

	} catch (error) {
		ErrorLogger.log(error, { route: 'PATCH /admin/orders/:id/notes' });

		if (error instanceof InvalidIdError) {
			return res.status(400).json({ success: false, message: 'ID đơn hàng không hợp lệ' });
		}

		if (error instanceof RecordValidationError) {
			return res.status(400).json({
				success: false,
				message: error.message
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi cập nhật ghi chú đơn hàng'
		});
	}
}));

/**
 * @route   DELETE /api/admin/orders
 * @desc    Delete all orders (DANGEROUS - Admin only)
 * @access  Private (Admin)
 */
router.delete('/', gated(async (req, res) => {
	try {
		console.log('🚨 DELETE ALL ORDERS Request:', {
			admin: req.admin.username,
			timestamp: new Date().toISOString(),
			userAgent: req.get('User-Agent')
		});

		// Count total orders before deletion for reporting
		const totalCount = await orders.count();

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
		const result = await orders.deleteAll();

		console.log('✅ Bulk deletion completed:', {
			deletedCount: result.deletedCount,
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
		// A failed destructive operation is logged with who ran it.
		ErrorLogger.log(error, {
			route: 'DELETE /admin/orders',
			operation: 'delete-all-orders',
			admin: req.admin.username
		});

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi xóa đơn hàng',
			error: process.env.NODE_ENV === 'development' ? error.message : undefined
		});
	}
}));

module.exports = router;
