/**
 * Figures for the admin dashboard on Postgres, with every count, sum and tally
 * computed by the database. Nothing here returns a BigInt: counts come from Prisma as numbers
 * and the raw query casts its sums to int.
 */
const { prisma } = require('../../lib/prisma');

// Orders that count as income.
const REVENUE_STATUSES = ['delivered', 'paid'];
const TOP_SELLING_LIMIT = 10;
const UNCATEGORISED = 'Khác';

/**
 * The best-selling lines over every order line whatever the order's status,
 * grouped by product id and name together. Quantity ranks, then the product id
 * and name, so equal quantities come back in the same order on every read.
 * Prisma's `groupBy` cannot sum a product of two columns, hence the raw query.
 * The `::int` sums rely on store totals staying far below 2^31 (about 2.1 billion VND).
 */
async function topSelling() {
	const rows = await prisma.$queryRaw`
		SELECT product_id, product_name, SUM(quantity)::int AS total_quantity, SUM(price * quantity)::int AS total_revenue
		FROM order_items
		GROUP BY product_id, product_name
		ORDER BY SUM(quantity) DESC, product_id, product_name
		LIMIT ${TOP_SELLING_LIMIT}`;
	return rows.map((row) => ({
		productId: row.product_id,
		productName: row.product_name,
		totalQuantity: row.total_quantity,
		totalRevenue: row.total_revenue
	}));
}

/** Order counts since each boundary, the income of paid and delivered orders, and the best-selling lines. */
async function summarizeOrders({ todayFrom, weekFrom, monthFrom }) {
	const [total, today, week, month, revenue, lines] = await Promise.all([
		prisma.order.count(),
		prisma.order.count({ where: { createdAt: { gte: todayFrom } } }),
		prisma.order.count({ where: { createdAt: { gte: weekFrom } } }),
		prisma.order.count({ where: { createdAt: { gte: monthFrom } } }),
		prisma.order.aggregate({ where: { status: { in: REVENUE_STATUSES } }, _sum: { totalAmount: true } }),
		topSelling()
	]);
	return { counts: { total, today, week, month }, revenue: revenue._sum.totalAmount ?? 0, topSelling: lines };
}

/** Product counts by category and by sales channel, grouped by the database. */
async function summarizeProducts() {
	const [categories, channels, available] = await Promise.all([
		prisma.product.groupBy({ by: ['category'], _count: { _all: true } }),
		prisma.product.groupBy({ by: ['salesChannel'], _count: { _all: true } }),
		prisma.product.count({ where: { available: true } })
	]);

	// A product with an empty category counts as uncategorised, together with any other.
	const byCategory = {};
	for (const group of categories) {
		const category = group.category || UNCATEGORISED;
		byCategory[category] = (byCategory[category] || 0) + group._count._all;
	}
	const byChannel = { all: 0, online: 0, offline: 0 };
	for (const group of channels) byChannel[group.salesChannel] = group._count._all;

	const total = Object.values(byChannel).reduce((sum, size) => sum + size, 0);
	return { total, available, unavailable: total - available, byCategory, byChannel };
}

/**
 * Everything the dashboard shows. `topSelling` covers order lines of every
 * status and groups by product id and name together, so a product sold under two
 * names has two rows; ties on quantity are broken by product id, then name.
 *
 * @param {{todayFrom: Date, weekFrom: Date, monthFrom: Date}} since start of today, this week and this month
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
