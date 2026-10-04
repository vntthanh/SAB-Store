const express = require('express');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const router = express.Router();

/**
 * @route   GET /api/admin/dashboard/stats
 * @desc    Get dashboard statistics
 * @access  Private (Admin authentication handled by parent router)
 */
router.get('/stats', async (req, res) => {
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
			Order.countDocuments(),
			Order.countDocuments({ createdAt: { $gte: startOfToday } }),
			Order.countDocuments({ createdAt: { $gte: startOfWeek } }),
			Order.countDocuments({ createdAt: { $gte: startOfMonth } }),
			Order.find({ status: { $in: ['delivered', 'paid'] } }),
			Order.aggregate([
				{ $match: { status: { $in: ['delivered', 'paid'] } } },
				{ $group: { _id: null, total: { $sum: '$totalAmount' } } }
			]),
			Order.aggregate([
				{ $unwind: '$items' },
				{
					$group: {
						_id: {
							productId: '$items.productId',
							productName: '$items.productName'
						},
						totalQuantity: { $sum: '$items.quantity' },
						totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }
					}
				},
				{ $sort: { totalQuantity: -1 } },
				{ $limit: 10 }
			])
		]);

		// Get all products for complete statistics
		const allProducts = await Product.find({}, 'name category available salesChannel');

		// Calculate product statistics
		const productsByCategory = allProducts.reduce((acc, product) => {
			const category = product.category || 'Khác';
			acc[category] = (acc[category] || 0) + 1;
			return acc;
		}, {});

		const availableProducts = allProducts.filter(p => p.available).length;
		const unavailableProducts = allProducts.filter(p => !p.available).length;

		// Products written before salesChannel existed have no value: they sell
		// everywhere, so they count as 'all'.
		const byChannel = { all: 0, online: 0, offline: 0 };
		for (const product of allProducts) {
			byChannel[product.salesChannel || 'all'] += 1;
		}

		res.json({
			success: true,
			data: {
				orders: {
					total: totalOrders,
					today: todayOrders,
					week: weekOrders,
					month: monthOrders
				},
				revenue: totalRevenue[0]?.total || 0,
				products: {
					total: allProducts.length,
					available: availableProducts,
					unavailable: unavailableProducts,
					byCategory: productsByCategory,
					byChannel,
					topSelling: productStats.map(item => ({
						productId: item._id.productId,
						productName: item._id.productName,
						totalQuantity: item.totalQuantity,
						totalRevenue: item.totalRevenue
					}))
				}
			}
		});

	} catch (error) {
		console.error('Error fetching dashboard stats:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thống kê dashboard'
		});
	}
});

module.exports = router;
