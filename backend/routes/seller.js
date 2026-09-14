const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { authenticateSeller } = require('../middleware/better-auth');
const { validatePasswordChange } = require('../middleware/validation');
const { getPaginationInfo, formatDate, formatCurrency } = require('../utils/helpers');
const { sendOrderToAppScript } = require('../utils/appscript');
const { generateDirectSalePaymentQR } = require('../utils/paymentHelper');
const ComboService = require('../services/ComboService');
const { auth } = require('../lib/auth');
const { StockError, deductStockForItems, restoreStockForItems, applyStatusTransitionStockEffect } = require('../services/stock');
const ErrorLogger = require('../utils/errorLogger');
const { asEnum, asSort, asDate, safeSearch, asPageLimit } = require('../utils/query-guard');
const router = express.Router();

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
							$sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] }
						},
						totalStock: { $sum: '$stockQuantity' }
					}
				}
			])
		]);

		// Get recent orders
		const recentOrders = await Order.find()
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
 */
router.put('/orders/:id/status', async (req, res) => {
	const { id } = req.params;
	try {
		const { status, transactionCode, cancelReason, note } = req.body;

		if (!ORDER_STATUSES.includes(status)) {
			return res.status(400).json({
				success: false,
				message: 'Trạng thái đơn hàng không hợp lệ'
			});
		}

		const existing = await Order.findById(id).lean();
		if (!existing) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy đơn hàng'
			});
		}

		const previousStatus = existing.status;

		// See routes/admin/orders.js PUT /:id for why a same-status transition
		// is rejected outright instead of falling through to a same-value
		// conditional update that would trivially match and "succeed" again.
		if (status === previousStatus) {
			return res.status(409).json({
				success: false,
				message: 'Đơn hàng đã ở trạng thái này'
			});
		}

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

		// Conditional transition (see routes/admin/orders.js PUT /:id for the
		// full rationale): only the request whose read of previousStatus still
		// matches at write time wins. This is the seller-facing route the POS
		// UI (DirectSalesPage) actually calls to cancel a direct sale — this
		// route never touched stock at all on cancel before, which left the
		// same asymmetric-accounting bug this phase closes in the admin route,
		// just reachable from the seller UI instead.
		const transitioned = await Order.findOneAndUpdate(
			{ _id: id, status: previousStatus },
			{ $set: setFields, $push: { statusHistory: historyEntry } },
			{ new: true, runValidators: true }
		).populate('items.productId', 'name imageUrl price');

		if (!transitioned) {
			return res.status(409).json({
				success: false,
				message: 'Đơn hàng vừa được người khác cập nhật, vui lòng tải lại và thử lại'
			});
		}

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

			ErrorLogger.logCritical('Cập nhật kho thất bại khi seller đổi trạng thái đơn hàng', stockErr, { orderId: id, previousStatus, status });
			return res.status(500).json({
				success: false,
				message: 'Lỗi khi cập nhật kho hàng'
			});
		}

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

		res.json({
			success: true,
			message: 'Cập nhật trạng thái đơn hàng thành công',
			data: {
				order: {
					...transitioned.toObject(),
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
 * Pricing is always computed server-side from the DB now. The previous
 * version had a branch that trusted `optimalPricing.summary.finalTotal` sent
 * by the client verbatim whenever `useOptimalPricing` was set — the same
 * class of bug Phase 05 fixed on the public POST /api/orders route, just
 * reachable here from the seller POS instead. That branch is removed.
 *
 * Pricing goes through ComboService.calculateOptimalPricing, not
 * services/pricing.js's computeOrderPricing — computeOrderPricing applies at
 * most one combo per order by contract, but the seller POS (DirectSalesPage)
 * can legitimately ring up a cart that qualifies for more than one different
 * combo (e.g. two lanyard+tag combos of different kinds in one sale), and
 * this phase does not silently drop that capability. See the phase report
 * for the full analysis of why this differs from the public order route.
 */
router.post('/orders/direct', async (req, res) => {
	try {
		const { items } = req.body;

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

		// Validate every product up front: ComboService.calculateOptimalPricing
		// silently drops unknown/inactive products from its result instead of
		// rejecting them, which would otherwise let a stale cart line vanish
		// from the order without the seller noticing.
		const productIds = [...new Set(items.map(item => String(item.productId)))];
		const validProducts = await Product.find({ _id: { $in: productIds }, isActive: true, available: true });
		const validIds = new Set(validProducts.map(p => p._id.toString()));
		const missingIds = productIds.filter(id => !validIds.has(id));
		if (missingIds.length > 0) {
			return res.status(400).json({
				success: false,
				message: 'Một hoặc nhiều sản phẩm không tồn tại hoặc không khả dụng',
				details: { missingIds }
			});
		}

		const pricing = await ComboService.calculateOptimalPricing(items);

		const orderItems = [];
		for (const applied of pricing.appliedCombos) {
			for (const used of applied.itemsUsed) {
				orderItems.push({
					productId: used.productId,
					productName: used.productName,
					quantity: used.quantity,
					price: used.price,
					fromCombo: true,
					comboId: applied.combo._id,
					comboName: applied.combo.name
				});
			}
		}
		for (const item of pricing.remainingItems) {
			orderItems.push({
				productId: item.productId,
				productName: item.product.name,
				quantity: item.quantity,
				price: item.product.price,
				fromCombo: false
			});
		}

		if (orderItems.length === 0) {
			return res.status(400).json({
				success: false,
				message: 'Danh sách sản phẩm không hợp lệ'
			});
		}

		const totalAmount = pricing.finalTotal;
		const comboInfo = pricing.appliedCombos.length > 0 ? {
			savings: pricing.totalSavings,
			originalTotal: pricing.originalTotal,
			finalTotal: pricing.finalTotal,
			combos: pricing.appliedCombos.map(c => ({
				comboId: c.combo._id,
				comboName: c.combo.name,
				applications: c.applications,
				savings: c.savings
			})),
			breakdown: pricing.breakdown
		} : null;

		const stockLines = orderItems.map(item => ({ productId: item.productId, quantity: item.quantity }));

		// Deduct stock atomically before persisting the order. A mid-loop
		// failure (a later line short on stock) compensates every line
		// already deducted, so a rejected direct sale never leaves stock
		// short — this replaces the old read-modify-write
		// `product.stockQuantity -= qty; await product.save()`, which two
		// sellers racing the last unit could both pass unharmed.
		try {
			await deductStockForItems(stockLines);
		} catch (stockErr) {
			if (stockErr instanceof StockError && stockErr.code === 'INSUFFICIENT_STOCK') {
				return res.status(400).json({
					success: false,
					message: 'Một hoặc nhiều sản phẩm không đủ số lượng trong kho',
					details: stockErr.details
				});
			}
			throw stockErr;
		}

		// orderNumber's base comes from a single pre-read; orderCode is
		// re-randomized every attempt. Either colliding on save() (E11000)
		// retries with a fresh pair — the pre-read only narrows the race, the
		// actual uniqueness guarantee is the retry loop below.
		const lastOrder = await Order.findOne(
			{ orderNumber: { $regex: /^SAB\d{6}$/ } },
			{ orderNumber: 1 }
		).sort({ orderNumber: -1 }).lean();
		const baseOrderNumber = lastOrder && lastOrder.orderNumber
			? parseInt(lastOrder.orderNumber.replace('SAB', ''), 10) + 1
			: 1;

		let order;
		let attempts = 0;
		const maxAttempts = 10;
		try {
			while (!order) {
				attempts++;
				if (attempts > maxAttempts) {
					throw Object.assign(new Error('ORDER_CODE_EXHAUSTED'), { code: 'ORDER_CODE_EXHAUSTED' });
				}

				const orderNumber = `SAB${String(baseOrderNumber + attempts - 1).padStart(6, '0')}`;
				// D100000-D999999 (900,000 values). Widened from the old
				// D1000-D9999 (9,000 values) format, which a handful of direct
				// sales a day could exhaust the practical collision-free space
				// of; old D#### codes already on real orders remain valid.
				const orderCode = `D${String(Math.floor(Math.random() * 900000) + 100000)}`;

				try {
					order = await new Order({
						orderNumber,
						orderCode,
						// For direct sales, don't include customer data fields
						fullName: `NB: ${req.seller.username}`,
						items: orderItems,
						totalAmount,
						status: 'confirmed',
						isDirectSale: true,
						stockDeducted: true,
						createdBy: req.seller?.id || null,
						lastUpdatedBy: req.seller?.username || 'unknown',
						comboInfo,
						statusHistory: [{
							status: 'confirmed',
							updatedBy: req.seller?.username || 'unknown',
							updatedAt: new Date()
						}]
					}).save();
				} catch (saveError) {
					if (saveError.code === 11000) continue; // orderNumber/orderCode collision, retry
					throw saveError;
				}
			}
		} catch (orderCreationError) {
			// Order never persisted — compensate the stock deducted above so a
			// failed direct sale never leaves stock permanently short.
			await restoreStockForItems(stockLines).catch(compensationError => {
				ErrorLogger.logCritical('Bù kho thất bại sau khi tạo đơn bán trực tiếp (seller) thất bại', compensationError, { stockLines });
			});

			if (orderCreationError.code === 'ORDER_CODE_EXHAUSTED') {
				return res.status(500).json({
					success: false,
					message: 'Không thể tạo mã đơn hàng duy nhất sau nhiều lần thử'
				});
			}
			throw orderCreationError;
		}

		// Generate payment QR URL for direct sales
		let qrUrl = null;
		try {
			const username = req.seller?.username || 'seller';
			qrUrl = await generateDirectSalePaymentQR(totalAmount, order.orderCode, username);
		} catch (qrError) {
			console.error('❌ Failed to generate direct sale QR URL:', qrError.message);
		}

		// Populate order for response
		const populatedOrder = await Order.findById(order._id)
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
