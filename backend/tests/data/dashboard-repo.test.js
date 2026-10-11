/**
 * Contract of the dashboard repository. Rows are seeded through the factories;
 * `makeLegacyProduct` stores a product without the fields added later.
 */
const { dashboard } = require('../../data');
const { makeProduct, makeOrder, makeLegacyProduct } = require('../helpers/factories');

const DAY = 86400000;
const since = () => {
	const now = Date.now();
	return { todayFrom: new Date(now - DAY / 2), weekFrom: new Date(now - 7 * DAY), monthFrom: new Date(now - 30 * DAY) };
};

const orderOf = (product, fields) => makeOrder({
	items: [{ productId: product._id, productName: product.name, price: 1000, quantity: fields.quantity }],
	totalAmount: 1000 * fields.quantity,
	...fields.order
});

describe('dashboard repository: orders', () => {
	it('counts orders since each boundary and sums income over paid and delivered orders only', async () => {
		const product = await makeProduct({ name: 'Counted' });
		await orderOf(product, { quantity: 1, order: { status: 'delivered', createdAt: new Date(Date.now() - 20 * DAY) } });
		await orderOf(product, { quantity: 2, order: { status: 'paid', createdAt: new Date(Date.now() - 3 * DAY) } });
		await orderOf(product, { quantity: 4, order: { status: 'confirmed' } });
		await orderOf(product, { quantity: 8, order: { status: 'cancelled' } });

		const { orders, revenue } = await dashboard.stats(since());

		expect(orders).toEqual({ total: 4, today: 2, week: 3, month: 4 });
		expect(revenue).toBe(3000);
	});

	it('ranks lines by quantity over every status, as a string product id, and keeps the ten best', async () => {
		const products = [];
		for (let i = 0; i < 12; i += 1) products.push(await makeProduct({ name: `Line ${i}` }));
		for (const [i, product] of products.entries()) {
			await orderOf(product, { quantity: i + 1, order: { status: ['confirmed', 'paid', 'cancelled'][i % 3] } });
		}

		const { products: { topSelling } } = await dashboard.stats(since());

		expect(topSelling).toHaveLength(10);
		expect(topSelling[0]).toEqual({ productId: String(products[11]._id), productName: 'Line 11', totalQuantity: 12, totalRevenue: 12000 });
		expect(topSelling.map((line) => line.totalQuantity)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
	});

	it('sums quantity and revenue over orders and over repeated lines, one row per product and name', async () => {
		const product = await makeProduct({ name: 'Summed' });
		const line = (quantity, price, productName = 'Summed') => ({ productId: product._id, productName, price, quantity });
		await makeOrder({ items: [line(2, 1000), line(3, 500)], totalAmount: 3500 });
		await makeOrder({ items: [line(1, 1000)], totalAmount: 1000, status: 'cancelled' });
		await makeOrder({ items: [line(4, 1000, 'Renamed')], totalAmount: 4000 });

		const { products: { topSelling } } = await dashboard.stats(since());

		expect(topSelling).toEqual([
			{ productId: String(product._id), productName: 'Summed', totalQuantity: 6, totalRevenue: 4500 },
			{ productId: String(product._id), productName: 'Renamed', totalQuantity: 4, totalRevenue: 4000 }
		]);
	});

	it('counts an order created exactly at a boundary, and files a product without a category under Khác', async () => {
		const boundary = new Date(Date.now() - 2 * DAY);
		const product = await makeProduct({ name: 'Edge' });
		await orderOf(product, { quantity: 1, order: { createdAt: boundary } });
		await makeLegacyProduct({ name: 'Uncategorised', category: '' });

		const { orders, products } = await dashboard.stats({ todayFrom: boundary, weekFrom: boundary, monthFrom: boundary });

		expect(orders).toMatchObject({ total: 1, today: 1, week: 1, month: 1 });
		expect(products.byCategory.Khác).toBe(1);
	});

	it('reports zeros for a store without orders', async () => {
		const { orders, revenue, products } = await dashboard.stats(since());

		expect(orders).toEqual({ total: 0, today: 0, week: 0, month: 0 });
		expect(revenue).toBe(0);
		expect(products.topSelling).toEqual([]);
	});
});

describe('dashboard repository: products', () => {
	it('tallies availability, categories and channels, a product stored without them counting with the defaults', async () => {
		await makeProduct({ category: 'pins', available: true, salesChannel: 'online' });
		await makeProduct({ category: 'pins', available: false, salesChannel: 'offline' });
		await makeProduct({ category: 'caps' });
		await makeLegacyProduct({ name: 'Old', category: 'caps' });

		const { products } = await dashboard.stats(since());

		expect(products).toMatchObject({ total: 4, available: 3, unavailable: 1, byCategory: { pins: 2, caps: 2 } });
		expect(products.byChannel).toEqual({ all: 2, online: 1, offline: 1 });
	});
});
