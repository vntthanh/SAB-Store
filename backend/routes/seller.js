const express = require('express');
const { ORDER_STATUSES } = require('@sab/shared');
const { authenticateSeller } = require('../middleware/better-auth');
const { validatePasswordChange, validateOrderUpdate, validateDirectOrder, trimStatusText } = require('../middleware/validation');
const { formatDate, formatCurrency } = require('../utils/helpers');
const { sendOrderToAppScript } = require('../utils/appscript');
const { generateDirectSalePaymentQR } = require('../utils/paymentHelper');
const { computeOrderPricing, assertExpectedTotal, pricingErrorBody, PricingError } = require('../services/pricing');
const { auth } = require('../lib/auth');
const { recordOrderMovements, transitionOrderWithStock } = require('../services/stock');
const { enqueueMovements } = require('../services/stock-ledger');
const { ERROR_CODES, ERROR_MESSAGES } = require('../constants/errorCodes');
const { orders, products, withTransaction } = require('../data');
const { isDuplicateKeyOn } = require('../data/errors');
const { gated } = require('../services/write-gate');
const { logEvent, orderCreatedFields } = require('../utils/log-event');
const { asEnum, asSort, asDate, asPageLimit } = require('../utils/query-guard');
const router = express.Router();

const MAX_ORDER_CODE_ATTEMPTS = 10;
const WRONG_CURRENT_PASSWORD = 'Mật khẩu hiện tại không đúng';
const ORDER_SORTABLE_FIELDS = ['createdAt', 'totalAmount', 'status', 'orderCode', 'orderNumber'];
const SEARCH_FIELDS = ['orderNumber', 'orderCode', 'fullName', 'studentId', 'email'];
// Internal notes and the edit history (whole previous item sets) are admin-only.
const ADMIN_ONLY_FIELDS = ['internalNotes', 'itemsHistory'];
const PRODUCT_LINE_FIELDS = ['name', 'imageUrl', 'price', 'category'];

// Apply seller authentication to all routes
router.use(authenticateSeller);

/**
 * @route   POST /api/seller/change-password
 * @desc    Change own password (seller or admin; the admin UI calls this too)
 * @access  Private (Seller or admin)
 */
router.post('/change-password', validatePasswordChange, async (req, res) => {
	try {
		const { currentPassword, newPassword } = req.body;

		// Use Better Auth changePassword endpoint
		const result = await auth.api.changePassword({
			body: {
				currentPassword,
				newPassword,
				revokeOtherSessions: true
			},
			headers: req.headers
		});

		if (result.error) {
			return res.status(400).json({
				success: false,
				message: result.error.message || 'Không thể đổi mật khẩu'
			});
		}

		res.json({
			success: true,
			message: 'Đổi mật khẩu thành công'
		});

	} catch (error) {
		// Better Auth throws (it does not return { error }) and a wrong current
		// password is the user's mistake, not a server fault.
		if (error?.body?.code === 'INVALID_PASSWORD') {
			return res.status(400).json({
				success: false,
				message: WRONG_CURRENT_PASSWORD,
				errors: [{ field: 'currentPassword', message: WRONG_CURRENT_PASSWORD }]
			});
		}
		console.error('Error changing seller password:', error?.message || error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi đổi mật khẩu'
		});
	}
});

/**
 * @route   GET /api/seller/dashboard/stats
 * @desc    Get seller dashboard statistics
 * @access  Private (Seller)
 */
router.get('/dashboard/stats', async (req, res) => {
	try {
		const now = new Date();
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
		const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

		const [summary, productStats, recentOrders] = await Promise.all([
			orders.summarize({ todayFrom: startOfToday, weekFrom: startOfWeek, monthFrom: startOfMonth }),
			products.summarizeCatalog(),
			orders.listRecent({ limit: 5, omit: ADMIN_ONLY_FIELDS, withProducts: ['name', 'imageUrl'] })
		]);

		res.json({
			success: true,
			data: {
				overview: {
					totalOrders: summary.total,
					todayOrders: summary.today,
					weekOrders: summary.week,
					monthOrders: summary.month,
					deliveredOrders: summary.delivered,
					totalRevenue: summary.deliveredRevenue,
					deliveryRate: summary.total > 0 ? Math.round((summary.delivered / summary.total) * 100) : 0
				},
				products: productStats,
				recentOrders: recentOrders.map(order => ({
					...order,
					statusText: getStatusInVietnamese(order.status),
					formattedDate: formatDate(order.createdAt),
					formattedTotal: formatCurrency(order.totalAmount)
				})),
				statusDistribution: summary.byStatus.map(item => ({
					status: item.status,
					statusText: getStatusInVietnamese(item.status),
					count: item.count
				}))
			}
		});

	} catch (error) {
		console.error('Seller dashboard stats error:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thống kê dashboard'
		});
	}
});

/**
 * @route   GET /api/seller/orders
 * @desc    Get orders for seller management
 * @access  Private (Seller)
 */
router.get('/orders', async (req, res) => {
	try {
		const { page, limit, status, search, startDate, endDate, sortBy, sortOrder } = req.query;

		const gte = asDate(startDate);
		const lte = asDate(endDate);

		const { data, meta } = await orders.listPage({
			...asPageLimit(page, limit),
			sort: asSort(sortBy, sortOrder, ORDER_SORTABLE_FIELDS),
			status: asEnum(status, ORDER_STATUSES),
			search,
			searchFields: SEARCH_FIELDS,
			createdFrom: gte,
			// endDate is a calendar-day boundary from the caller; extend it
			// to the end of that day so "search up to endDate" is inclusive.
			createdTo: lte && new Date(lte.getTime() + 24 * 60 * 60 * 1000 - 1),
			omit: ADMIN_ONLY_FIELDS,
			withProducts: PRODUCT_LINE_FIELDS,
			complete: true
		});

		res.json({
			success: true,
			data: data.map(order => ({
				...order,
				statusText: getStatusInVietnamese(order.status),
				formattedDate: formatDate(order.createdAt),
				formattedTotal: formatCurrency(order.totalAmount)
			})),
			meta
		});

	} catch (error) {
		console.error('Get orders error:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy danh sách đơn hàng'
		});
	}
});

/**
 * @route   PUT /api/seller/orders/:id/status
 * @desc    Update order status
 * @access  Private (Seller)
 *
 * Runs validateOrderUpdate, as the admin route does: Mongoose would reject an
 * over-length note too, but this route's catch-all would turn that into a 500
 * instead of a 400. The validator also checks the status against the enum.
 */
router.put('/orders/:id/status', validateOrderUpdate, gated(async (req, res) => {
	const { id } = req.params;
	try {
		const { status } = req.body;
		const { transactionCode, cancelReason, note } = trimStatusText(req.body);

		const historyEntry = {
			status,
			updatedAt: new Date(),
			updatedBy: req.seller.username
		};
		const setFields = {
			status,
			statusUpdatedAt: new Date(),
			lastUpdatedBy: req.seller.username
		};
		if (transactionCode) {
			setFields.transactionCode = transactionCode;
			historyEntry.transactionCode = transactionCode;
		}
		if (cancelReason) {
			setFields.cancelReason = cancelReason;
			historyEntry.cancelReason = cancelReason;
		}
		if (note) {
			historyEntry.note = note;
		}

		// Status and stock movement commit together (see transitionOrderWithStock),
		// and a request that lost a race for the same order is told so instead of
		// transitioning it a second time.
		const result = await transitionOrderWithStock({
			orderId: id,
			status,
			setFields,
			historyEntry,
			actor: req.seller.username
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

		const transitioned = await orders.attachProducts(result.order, ['name', 'imageUrl', 'price']);

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
				console.error('Gửi đơn hàng lên App Script thất bại:', err.message);
			});
		});

		const { internalNotes: _adminOnly, itemsHistory: _adminHistory, ...visibleOrder } = transitioned;
		res.json({
			success: true,
			message: 'Cập nhật trạng thái đơn hàng thành công',
			data: {
				order: {
					...visibleOrder,
					statusText: getStatusInVietnamese(transitioned.status),
					formattedDate: formatDate(transitioned.createdAt),
					formattedTotal: formatCurrency(transitioned.totalAmount)
				}
			}
		});

	} catch (error) {
		console.error('Update order status error:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi cập nhật trạng thái đơn hàng'
		});
	}
}));

/**
 * @route   GET /api/seller/orders/:id
 * @desc    Get order details
 * @access  Private (Seller)
 */
router.get('/orders/:id', async (req, res) => {
	try {
		const { id } = req.params;

		const order = await orders.findDetail(id, { omit: ADMIN_ONLY_FIELDS, withProducts: PRODUCT_LINE_FIELDS });

		if (!order) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy đơn hàng'
			});
		}

		res.json({
			success: true,
			data: {
				order: {
					...order,
					statusText: getStatusInVietnamese(order.status),
					formattedDate: formatDate(order.createdAt),
					formattedTotal: formatCurrency(order.totalAmount)
				}
			}
		});

	} catch (error) {
		console.error('Get order details error:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy chi tiết đơn hàng'
		});
	}
});

/**
 * @route   POST /api/seller/orders/direct
 * @desc    Create direct sale order
 * @access  Private (Seller)
 *
 * Pricing is always computed server-side from the DB through
 * services/pricing.js on the offline channel — the same engine as the cart
 * preview, so a counter sale can ring up a cart that qualifies for several
 * different combos. The client sends only ids, quantities and the
 * `expectedTotal` it displayed; a stale total is refused with 409.
 *
 * A product's `maxOrderQuantity` is a limit the cashier may override: over it,
 * the sale is refused with 409 QUANTITY_OVER_MAX until the client resends with
 * `allowOverMax: true`, and the order's history then records who confirmed it.
 */
router.post('/orders/direct', validateDirectOrder, gated(async (req, res) => {
	try {
		const { items, expectedTotal } = req.body;

		if (!items || !Array.isArray(items) || items.length === 0) {
			return res.status(400).json({
				success: false,
				message: 'Danh sách sản phẩm không hợp lệ'
			});
		}

		for (const item of items) {
			if (!item || !item.productId || !Number.isInteger(item.quantity) || item.quantity <= 0) {
				return res.status(400).json({
					success: false,
					message: 'Thông tin sản phẩm không hợp lệ'
				});
			}
		}

		const username = req.seller?.username || 'unknown';

		// Price, order and stock movements are one transaction; stock is never
		// checked, so a counter sale for a product with none left goes through.
		// A duplicate orderNumber / orderCode aborts the transaction and
		// the whole thing runs again: orderNumber is read from the latest order
		// each time, orderCode is drawn afresh.
		let created;
		for (let attempt = 1; !created; attempt++) {
			try {
				created = await withTransaction(async (tx) => {
					const pricing = await computeOrderPricing(items, {
						channel: 'offline',
						session: tx,
						enforceQuantityLimits: true,
						allowOverMax: req.body.allowOverMax === true
					});
					assertExpectedTotal(expectedTotal, pricing.totalAmount);

					const lastNumber = await orders.latestOrderNumber(tx);
					const nextNumber = lastNumber ? parseInt(lastNumber.replace('SAB', ''), 10) + 1 : 1;

					// D100000-D999999 (900,000 values); old D#### codes on existing
					// orders remain valid.
					const orderCode = `D${String(Math.floor(Math.random() * 900000) + 100000)}`;

					const order = await orders.create({
						orderNumber: `SAB${String(nextNumber).padStart(6, '0')}`,
						orderCode,
						// For direct sales, don't include customer data fields
						fullName: `NB: ${req.seller.username}`,
						items: pricing.orderItems,
						totalAmount: pricing.totalAmount,
						status: 'confirmed',
						isDirectSale: true,
						stockDeducted: true,
						createdBy: req.seller?.id || null,
						lastUpdatedBy: username,
						comboInfo: pricing.comboInfo,
						statusHistory: [{
							status: 'confirmed',
							updatedBy: username,
							updatedAt: new Date(),
							// What the cashier confirmed, kept on the order for reconciliation.
							...(pricing.overMaxLines.length > 0 && {
								note: `Bán vượt số lượng tối đa — xác nhận bởi ${username}`
							})
						}]
					}, tx);

					const movements = await recordOrderMovements({
						orderId: order._id,
						items: pricing.orderItems,
						type: 'order',
						keyTag: 'create',
						createdBy: username,
						reason: `Bán trực tiếp ${order.orderCode}`
					}, { tx });

					return { order, pricing, movements };
				});
			} catch (error) {
				if (error instanceof PricingError) {
					return res.status(error.httpStatus).json(pricingErrorBody(error));
				}
				const codeCollision = isDuplicateKeyOn(error, 'orderNumber', 'orderCode');
				if (codeCollision && attempt < MAX_ORDER_CODE_ATTEMPTS) continue;
				if (codeCollision) {
					return res.status(500).json({
						success: false,
						message: 'Không thể tạo mã đơn hàng duy nhất sau nhiều lần thử'
					});
				}
				throw error;
			}
		}

		const { order, pricing: { comboInfo, totalAmount, orderItems }, movements } = created;

		// The order is durable; only now may anything leave the transaction.
		logEvent('order.created', orderCreatedFields({ channel: 'offline', orderItems, totalAmount, comboInfo }));
		await enqueueMovements(movements);

		// Generate payment QR URL for direct sales
		let qrUrl = null;
		try {
			qrUrl = await generateDirectSalePaymentQR(totalAmount, order.orderCode, req.seller?.username || 'seller');
		} catch (qrError) {
			console.error('❌ Failed to generate direct sale QR URL:', qrError.message);
		}

		// Response carries each item's product name and image, as the order screens show them.
		const orderDetail = await orders.findDetail(order._id, { omit: ADMIN_ONLY_FIELDS, withProducts: ['name', 'imageUrl'] });

		res.status(201).json({
			success: true,
			message: 'Tạo đơn hàng bán trực tiếp thành công',
			data: {
				...orderDetail,
				comboInfo,
				qrUrl,
				statusText: getStatusInVietnamese(orderDetail.status),
				formattedTotal: formatCurrency(orderDetail.totalAmount)
			}
		});

	} catch (error) {
		console.error('Create direct order error:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi tạo đơn hàng bán trực tiếp'
		});
	}
}));

/**
 * Helper function to get status in Vietnamese
 * @param {String} status - Order status
 */
function getStatusInVietnamese(status) {
	const statusMap = {
		'pending': 'Chờ xử lý',
		'confirmed': 'Đã xác nhận',
		'paid': 'Đã thanh toán',
		'delivered': 'Đã giao hàng',
		'cancelled': 'Đã hủy'
	};
	return statusMap[status] || status;
}

module.exports = router;
