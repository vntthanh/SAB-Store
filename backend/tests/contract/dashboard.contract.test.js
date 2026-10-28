/**
 * The dashboard repository contract.
 * Rows go in through the raw oracle, so what is counted is what is stored.
 */
const { dashboard } = require('../../data');
const { insertRawProduct, insertRawOrder } = require('../helpers/db');

afterAll(async () => {
	await require('../../lib/prisma').closeDb();
});

const DAY = 86400000;
const since = () => {
	const now = Date.now();
	return { todayFrom: new Date(now - DAY / 2), weekFrom: new Date(now - 7 * DAY), monthFrom: new Date(now - 30 * DAY) };
};

let sequence = 0;
const makeProduct = (fields = {}) => insertRawProduct({ name: `Dash ${++sequence}`, price: 1000, category: 'general', available: true, ...fields });
const lineOf = (product, quantity, { price = 1000, productName = product.name } = {}) => ({ productId: product._id, productName, price, quantity });
const makeOrder = (fields) => insertRawOrder({ orderCode: `H${Date.now().toString(36).slice(-4).toUpperCase()}${++sequence}`.slice(0, 10), ...fields });

describe('dashboard.stats: orders', () => {
	it('counts orders since each boundary and sums income over paid and delivered orders only', async () => {
		await makeOrder({ status: 'delivered', totalAmount: 1000, createdAt: new Date(Date.now() - 20 * DAY) });
		await makeOrder({ status: 'paid', totalAmount: 2000, createdAt: new Date(Date.now() - 3 * DAY) });
		await makeOrder({ status: 'confirmed', totalAmount: 4000 });
		await makeOrder({ status: 'cancelled', totalAmount: 8000 });

		const { orders, revenue } = await dashboard.stats(since());

		expect(orders).toEqual({ total: 4, today: 2, week: 3, month: 4 });
		expect(revenue).toBe(3000);
	});

	it('is all zeros and empty lists for an empty store, and serialises to JSON', async () => {
		const stats = await dashboard.stats(since());

		expect(stats).toEqual({
			orders: { total: 0, today: 0, week: 0, month: 0 },
			revenue: 0,
			products: { total: 0, available: 0, unavailable: 0, byCategory: {}, byChannel: { all: 0, online: 0, offline: 0 }, topSelling: [] }
		});
		expect(() => JSON.stringify(stats)).not.toThrow();
	});
});

describe('dashboard.stats: topSelling', () => {
	it('ranks lines by quantity over every status, as string product ids, and keeps the ten best', async () => {
		const products = [];
		for (let i = 0; i < 12; i += 1) products.push(await makeProduct({ name: `Line ${i}` }));
		for (const [i, product] of products.entries()) {
			await makeOrder({ status: ['confirmed', 'paid', 'cancelled'][i % 3], items: [lineOf(product, i + 1)] });
		}

		const { products: { topSelling } } = await dashboard.stats(since());

		expect(topSelling).toHaveLength(10);
		expect(topSelling[0]).toEqual({ productId: products[11]._id, productName: 'Line 11', totalQuantity: 12, totalRevenue: 12000 });
		expect(topSelling.map((line) => line.totalQuantity)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
		expect(topSelling.every((line) => typeof line.productId === 'string' && Number.isInteger(line.totalQuantity) && Number.isInteger(line.totalRevenue))).toBe(true);
		expect(() => JSON.stringify(topSelling)).not.toThrow();
	});

	it('sums quantity and revenue over orders and repeated lines, one row per product and name', async () => {
		const product = await makeProduct({ name: 'Summed' });
		await makeOrder({ items: [lineOf(product, 2), lineOf(product, 3, { price: 500 })] });
		await makeOrder({ status: 'cancelled', items: [lineOf(product, 1)] });
		await makeOrder({ items: [lineOf(product, 4, { productName: 'Renamed' })] });

		const { products: { topSelling } } = await dashboard.stats(since());

		expect(topSelling).toEqual([
			{ productId: product._id, productName: 'Summed', totalQuantity: 6, totalRevenue: 4500 },
			{ productId: product._id, productName: 'Renamed', totalQuantity: 4, totalRevenue: 4000 }
		]);
	});

	it('breaks a tie on quantity by product id, so equal sellers come back in one order', async () => {
		const products = [];
		for (let i = 0; i < 6; i += 1) products.push(await makeProduct({ name: `Tie ${i}` }));
		// Written in reverse, so insertion order is the opposite of id order.
		for (const product of [...products].reverse()) await makeOrder({ items: [lineOf(product, 5)] });

		const { products: { topSelling } } = await dashboard.stats(since());

		expect(topSelling.map((line) => line.productId)).toEqual(products.map((product) => product._id).sort());
	});

	it('breaks a tie between two names of one product by name', async () => {
		const product = await makeProduct();
		await makeOrder({ items: [lineOf(product, 2, { productName: 'Zeta' })] });
		await makeOrder({ items: [lineOf(product, 2, { productName: 'Alpha' })] });

		const { products: { topSelling } } = await dashboard.stats(since());

		expect(topSelling.map((line) => line.productName)).toEqual(['Alpha', 'Zeta']);
	});
});

describe('dashboard.stats: products', () => {
	it('tallies by category and channel and splits available from unavailable', async () => {
		await makeProduct({ category: 'Áo', salesChannel: 'online' });
		await makeProduct({ category: 'Áo', salesChannel: 'offline', available: false });
		await makeProduct({ category: 'Mũ', salesChannel: 'all' });
		await makeProduct({ category: 'Mũ', salesChannel: 'all', available: false });
		await makeProduct({ category: 'Mũ', salesChannel: 'online' });
		// No channel at all: sold everywhere, so counted under 'all' (a column default).
		await makeProduct({ category: 'Khác' });

		const { products } = await dashboard.stats(since());

		expect(products).toMatchObject({
			total: 6,
			available: 4,
			unavailable: 2,
			byCategory: { 'Áo': 2, 'Mũ': 3, 'Khác': 1 },
			byChannel: { all: 3, online: 2, offline: 1 }
		});
	});

	it('counts a product with an empty category as uncategorised', async () => {
		await makeProduct({ category: '' });
		await makeProduct({ category: 'Khác' });

		expect((await dashboard.stats(since())).products.byCategory).toEqual({ 'Khác': 2 });
	});
});
