/**
 * Figures for the admin dashboard, read across orders and the catalogue.
 */
const Order = require('../../models/Order');
const Product = require('../../models/Product');

// Orders that count as income.
const REVENUE_STATUSES = ['delivered', 'paid'];
const TOP_SELLING_LIMIT = 10;

/** `productId` is a string like every other id a repository hands out; a line without one stays without. */
const asId = (id) => (id === null || id === undefined ? id : String(id));

/** Order counts since each boundary, the income of paid and delivered orders, and the best-selling lines. */
async function summarizeOrders({ todayFrom, weekFrom, monthFrom }) {
	const [total, today, week, month, revenue, topSelling] = await Promise.all([
		Order.countDocuments(),
		Order.countDocuments({ createdAt: { $gte: todayFrom } }),
		Order.countDocuments({ createdAt: { $gte: weekFrom } }),
		Order.countDocuments({ createdAt: { $gte: monthFrom } }),
		Order.aggregate([
			{ $match: { status: { $in: REVENUE_STATUSES } } },
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
			{ $limit: TOP_SELLING_LIMIT }
		])
	]);
	return {
		counts: { total, today, week, month },
		revenue: revenue[0]?.total || 0,
		topSelling: topSelling.map((entry) => ({
			productId: asId(entry._id.productId),
			productName: entry._id.productName,
			totalQuantity: entry.totalQuantity,
			totalRevenue: entry.totalRevenue
		}))
	};
}

/**
 * Product counts by category and by sales channel. Read as documents, so a row
 * stored before a field existed counts with that field's schema default.
 * Tallied here over every product rather than grouped by the database; a
 * database backend must group in the database instead.
 */
async function summarizeProducts() {
	const all = await Product.find({}, 'name category available salesChannel');

	const byCategory = {};
	for (const product of all) {
		const category = product.category || 'Khác';
		byCategory[category] = (byCategory[category] || 0) + 1;
	}

	// A product written before salesChannel existed has no value: it sells
	// everywhere, so it counts as 'all'.
	const byChannel = { all: 0, online: 0, offline: 0 };
	for (const product of all) {
		byChannel[product.salesChannel || 'all'] += 1;
	}

	const available = all.filter((product) => product.available).length;
	return { total: all.length, available, unavailable: all.length - available, byCategory, byChannel };
}

/**
 * Everything the dashboard shows.
 *
 * `topSelling` covers order lines of every status and groups by product id and
 * name together, so a product sold under two names has two rows. It is ordered by
 * quantity only: lines with the same quantity come in no fixed order.
 *
 * @param {{todayFrom: Date, weekFrom: Date, monthFrom: Date}} since start of today, this week and this month
 * @returns {Promise<{orders: {total: number, today: number, week: number, month: number}, revenue: number,
 *   products: {total: number, available: number, unavailable: number, byCategory: Object<string, number>,
 *   byChannel: {all: number, online: number, offline: number},
 *   topSelling: {productId: string, productName: string, totalQuantity: number, totalRevenue: number}[]}}>}
 */
async function stats(since) {
	const orders = await summarizeOrders(since);
	const products = await summarizeProducts();
	return {
		orders: orders.counts,
		revenue: orders.revenue,
		products: { ...products, topSelling: orders.topSelling }
	};
}

module.exports = { stats };
