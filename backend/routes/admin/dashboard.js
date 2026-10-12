const express = require('express');
const { dashboard } = require('../../data');
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

		const data = await dashboard.stats({
			todayFrom: startOfToday,
			weekFrom: startOfWeek,
			monthFrom: startOfMonth
		});

		res.json({ success: true, data });

	} catch (error) {
		console.error('Error fetching dashboard stats:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thống kê dashboard'
		});
	}
});

module.exports = router;
