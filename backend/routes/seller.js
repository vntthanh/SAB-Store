const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { authenticateSeller } = require('../middleware/better-auth');
const { validatePasswordChange, validateOrderUpdate, validateDirectOrder } = require('../middleware/validation');
const { getPaginationInfo, formatDate, formatCurrency } = require('../utils/helpers');
const { sendOrderToAppScript } = require('../utils/appscript');
const { generateDirectSalePaymentQR } = require('../utils/paymentHelper');
const { computeOrderPricing, assertExpectedTotal, pricingErrorBody, PricingError } = require('../services/pricing');
const { auth } = require('../lib/auth');
const { recordOrderMovements, transitionOrderWithStock } = require('../services/stock');
const { enqueueMovements } = require('../services/stock-ledger');
const { ERROR_CODES, ERROR_MESSAGES } = require('../constants/errorCodes');
const { withTransaction } = require('../utils/transaction');
const { asEnum, asSort, asDate, safeSearch, asPageLimit } = require('../utils/query-guard');
const router = express.Router();

const MAX_ORDER_CODE_ATTEMPTS = 10;
const ORDER_STATUSES = ['confirmed', 'paid', 'delivered', 'cancelled'];
const ORDER_SORTABLE_FIELDS = ['createdAt', 'totalAmount', 'status', 'orderCode', 'orderNumber'];

// Apply seller authentication to all routes
router.use(authenticateSeller);

/**
 * @route   POST /api/seller/change-password
 * @desc    Change seller password
 * @access  Private (Seller only)
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
		console.error('Error changing seller password:', error);
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

		// Orders statistics
		const [
			totalOrders,
			todayOrders,
			weekOrders,
			monthOrders,
			deliveredOrders,
			totalRevenue,
			productStats
		] = await Promise.all([
			// Total orders
			Order.countDocuments(),

			// Today's orders
			Order.countDocuments({ createdAt: { $gte: startOfToday } }),

			// This week's orders
			Order.countDocuments({ createdAt: { $gte: startOfWeek } }),

			// This month's orders
			Order.countDocuments({ createdAt: { $gte: startOfMonth } }),

			// Delivered orders
			Order.countDocuments({ status: 'delivered' }),

			// Total revenue (from delivered orders)
			Order.aggregate([
				{ $match: { status: 'delivered' } },
				{ $group: { _id: null, total: { $sum: '$totalAmount' } } }
			]),

			// Product statistics
			Product.aggregate([
				{
					$group: {
						_id: null,
						totalProducts: { $sum: 1 },
						activeProducts: {
							$sum: { $cond: [{ $eq: ['$available', true] }, 1, 0] }
						},
						totalStock: { $sum: '$stockQuantity' }
					}
				}
			])
		]);

		// Get recent orders
		const recentOrders = await Order.find()
			.select('-internalNotes -itemsHistory')
			.populate('items.productId', 'name imageUrl')
			.sort({ createdAt: -1 })
			.limit(5)
			.lean();

		// Order status distribution
		const statusDistribution = await Order.aggregate([
			{
				$group: {
					_id: '$status',
					count: { $sum: 1 }
				}
			}
		]);

		res.json({
			success: true,
			data: {
				overview: {
					totalOrders,
					todayOrders,
					weekOrders,
					monthOrders,
					deliveredOrders,
					totalRevenue: totalRevenue[0]?.total || 0,
					deliveryRate: totalOrders > 0 ? Math.round((deliveredOrders / totalOrders) * 100) : 0
				},
				products: {
					total: productStats[0]?.totalProducts || 0,
					active: productStats[0]?.activeProducts || 0,
					totalStock: productStats[0]?.totalStock || 0
				},
				recentOrders: recentOrders.map(order => ({
					...order,
					statusText: getStatusInVietnamese(order.status),
					formattedDate: formatDate(order.createdAt),
					formattedTotal: formatCurrency(order.totalAmount)
				})),
				statusDistribution: statusDistribution.map(item => ({
					status: item._id,
					statusText: getStatusInVietnamese(item._id),
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

		// Build filter
		const statusFilter = asEnum(status, ORDER_STATUSES);
		const searchMatch = safeSearch(search);
		const filter = {
			...(statusFilter && { status: statusFilter }),
			...(searchMatch && {
				$or: [
					{ orderNumber: searchMatch },
					{ orderCode: searchMatch },
					{ fullName: searchMatch },
					{ studentId: searchMatch },
					{ email: searchMatch }
				]
			})
		};

		const gte = asDate(startDate);
		const lte = asDate(endDate);
		if (gte || lte) {
			filter.createdAt = {
				...(gte && { $gte: gte }),
				// endDate is a calendar-day boundary from the caller; extend it
				// to the end of that day so "search up to endDate" is inclusive.
				...(lte && { $lte: new Date(lte.getTime() + 24 * 60 * 60 * 1000 - 1) })
			};
		}

		const { page: pageNum, limit: limitNum } = asPageLimit(page, limit);
		const sort = asSort(sortBy, sortOrder, ORDER_SORTABLE_FIELDS);

		const options = {
			page: pageNum,
			limit: limitNum,
			sort,
			select: '-internalNotes -itemsHistory',
			populate: [
				{
					path: 'items.productId',
					select: 'name imageUrl price category'
				}
			]
		};

		const result = await Order.paginate(filter, options);

		// Format orders for response
		const formattedOrders = result.docs.map(order => ({
			...order.toObject(),
			statusText: getStatusInVietnamese(order.status),
			formattedDate: formatDate(order.createdAt),
			formattedTotal: formatCurrency(order.totalAmount)
		}));

		res.json({
			success: true,
			data: {
				orders: formattedOrders,
				pagination: {
					page: result.page,
					pages: result.totalPages,
					total: result.totalDocs,
					limit: result.limit
				}
			}
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
router.put('/orders/:id/status', validateOrderUpdate, async (req, res) => {
	const { id } = req.params;
	try {
		const { status, transactionCode, cancelReason, note } = req.body;

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

		// The transaction's session has ended; populate must not reuse it.
		const transitioned = result.order;
		transitioned.$session(null);
		await transitioned.populate('items.productId', 'name imageUrl price');

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
				console.error('Gửi đơn hàng lên App Script thất bại:', err.message);
			});
		});

		// Internal notes and the edit history (whole previous item sets) are admin-only.
		const { internalNotes: _adminOnly, itemsHistory: _adminHistory, ...visibleOrder } = transitioned.toObject();
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
});

/**
 * @route   GET /api/seller/orders/:id
 * @desc    Get order details
 * @access  Private (Seller)
 */
router.get('/orders/:id', async (req, res) => {
	try {
		const { id } = req.params;

		const order = await Order.findById(id)
			.select('-internalNotes -itemsHistory')
			.populate('items.productId', 'name imageUrl price category')
			.lean();

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
router.post('/orders/direct', validateDirectOrder, async (req, res) => {
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
		// A duplicate orderNumber / orderCode (E11000) aborts the transaction and
		// the whole thing runs again: orderNumber is read from the latest order
		// each time, orderCode is drawn afresh.
		let created;
		for (let attempt = 1; !created; attempt++) {
			try {
				created = await withTransaction(async (session) => {
					const pricing = await computeOrderPricing(items, {
						channel: 'offline',
						session,
						enforceQuantityLimits: true,
						allowOverMax: req.body.allowOverMax === true
					});
					assertExpectedTotal(expectedTotal, pricing.totalAmount);

					const lastOrder = await Order.findOne(
						{ orderNumber: { $regex: /^SAB\d{6}$/ } },
						{ orderNumber: 1 }
					).sort({ orderNumber: -1 }).session(session).lean();
					const nextNumber = lastOrder && lastOrder.orderNumber
						? parseInt(lastOrder.orderNumber.replace('SAB', ''), 10) + 1
						: 1;

					// D100000-D999999 (900,000 values); old D#### codes on existing
					// orders remain valid.
					const orderCode = `D${String(Math.floor(Math.random() * 900000) + 100000)}`;

					const order = await new Order({
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
					}).save({ session });

					const movements = await recordOrderMovements({
						orderId: order._id,
						items: pricing.orderItems,
						type: 'order',
						keyTag: 'create',
						createdBy: username,
						reason: `Bán trực tiếp ${order.orderCode}`
					}, { session });

					return { order, pricing, movements };
				});
			} catch (error) {
				if (error instanceof PricingError) {
					return res.status(error.httpStatus).json(pricingErrorBody(error));
				}
				if (error.code === 11000 && attempt < MAX_ORDER_CODE_ATTEMPTS) continue;
				if (error.code === 11000) {
					return res.status(500).json({
						success: false,
						message: 'Không thể tạo mã đơn hàng duy nhất sau nhiều lần thử'
					});
				}
				throw error;
			}
		}

		const { order, pricing: { comboInfo, totalAmount }, movements } = created;

		// The order is durable; only now may anything leave the transaction.
		await enqueueMovements(movements);

		// Generate payment QR URL for direct sales
		let qrUrl = null;
		try {
			qrUrl = await generateDirectSalePaymentQR(totalAmount, order.orderCode, req.seller?.username || 'seller');
		} catch (qrError) {
			console.error('❌ Failed to generate direct sale QR URL:', qrError.message);
		}

		// Populate order for response
		const populatedOrder = await Order.findById(order._id)
			.select('-internalNotes -itemsHistory')
			.populate('items.productId', 'name imageUrl')
			.lean();

		res.status(201).json({
			success: true,
			message: 'Tạo đơn hàng bán trực tiếp thành công',
			data: {
				...populatedOrder,
				comboInfo,
				qrUrl,
				statusText: getStatusInVietnamese(populatedOrder.status),
				formattedTotal: formatCurrency(populatedOrder.totalAmount)
			}
		});

	} catch (error) {
		console.error('Create direct order error:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi tạo đơn hàng bán trực tiếp'
		});
	}
});

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
