/**
 * Preview = charge: the total a client displays is echoed back as
 * `expectedTotal`; a mismatch refuses the order, a missing one is a 400.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const Combo = require('../../models/Combo');

const line = (product, quantity = 1) => ({ productId: product._id.toString(), quantity });
const customer = {
	studentId: 'SV12345',
	fullName: 'Nguyen Van A',
	email: 'nguyenvana@example.com',
	phoneNumber: '0987654321'
};

async function comboShop() {
	const string = await makeProduct({ category: 'string', price: 30000, stockQuantity: 20 });
	const tag = await makeProduct({ category: 'tag', price: 20000, stockQuantity: 20 });
	await makeCombo({ price: 45000, categoryRequirements: [{ category: 'string', quantity: 1 }, { category: 'tag', quantity: 1 }] });
	await makeCombo({ price: 35000, categoryRequirements: [{ category: 'tag', quantity: 3 }] });
	return { string, tag, items: [line(string, 2), line(tag, 4)] };
}

describe('preview total equals the charged total', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it('online: an order placed with the previewed total is created for exactly that amount', async () => {
		const { items } = await comboShop();

		const preview = await request(app).post('/api/combos/pricing').send({ items });
		const res = await request(app).post('/api/orders').send({ ...customer, items, expectedTotal: preview.body.data.totalAmount });

		expect(preview.body.data.totalAmount).toBe(110000);
		expect(res.status).toBe(201);
		expect(res.body.data.totalAmount).toBe(preview.body.data.totalAmount);
		const saved = await Order.findOne({ orderCode: res.body.data.orderCode });
		expect(saved.totalAmount).toBe(110000);
		expect(saved.comboInfo.combos).toHaveLength(2);
	});

	it('counter: an order placed with the previewed total is created for exactly that amount', async () => {
		const { items } = await comboShop();

		const preview = await request(app).post('/api/combos/pricing').send({ items, channel: 'offline' });
		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items, expectedTotal: preview.body.data.totalAmount });

		expect(res.status).toBe(201);
		expect(res.body.data.totalAmount).toBe(preview.body.data.totalAmount);
		expect(res.body.data.comboInfo.combos).toHaveLength(2);
	});

	it('online: a price change between preview and order is refused with 409 and no order', async () => {
		const { string, items } = await comboShop();
		const preview = await request(app).post('/api/combos/pricing').send({ items });

		await Product.updateOne({ _id: string._id }, { price: 31000 });
		const res = await request(app).post('/api/orders').send({ ...customer, items, expectedTotal: preview.body.data.totalAmount });

		expect(res.status).toBe(409);
		expect(res.body.code).toBe('PRICE_CHANGED');
		expect(res.body.details.expectedTotal).toBe(110000);
		expect(res.body.details.totalAmount).toBe(111000);
		expect(await Order.countDocuments({})).toBe(0);
	});

	it('counter: a price change between preview and order is refused with 409, no order, stock untouched', async () => {
		const { string, tag, items } = await comboShop();
		const preview = await request(app).post('/api/combos/pricing').send({ items, channel: 'offline' });

		await Product.updateOne({ _id: string._id }, { price: 31000 });
		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items, expectedTotal: preview.body.data.totalAmount });

		expect(res.status).toBe(409);
		expect(res.body.code).toBe('PRICE_CHANGED');
		expect(await Order.countDocuments({})).toBe(0);
		expect((await Product.findById(string._id)).stockQuantity).toBe(20);
		expect((await Product.findById(tag._id)).stockQuantity).toBe(20);
	});

	it('a combo switched off between preview and order also refuses with 409', async () => {
		const { items } = await comboShop();
		const preview = await request(app).post('/api/combos/pricing').send({ items });

		await Combo.updateMany({}, { isActive: false });
		const res = await request(app).post('/api/orders').send({ ...customer, items, expectedTotal: preview.body.data.totalAmount });

		expect(res.status).toBe(409);
	});

	it.each([
		['missing', undefined],
		['null', null],
		['a numeric string', '110000'],
		['negative', -1],
		['fractional', 10.5]
	])('rejects %s expectedTotal with 400 on both order routes and creates nothing', async (_label, value) => {
		const product = await makeProduct({ price: 10000, stockQuantity: 5 });
		const items = [line(product)];
		const body = value === undefined ? {} : { expectedTotal: value };

		const online = await request(app).post('/api/orders').send({ ...customer, items, ...body });
		const counter = await request(app).post('/api/seller/orders/direct').set('Cookie', cookies).send({ items, ...body });

		expect(online.status).toBe(400);
		expect(counter.status).toBe(400);
		expect(await Order.countDocuments({})).toBe(0);
		expect((await Product.findById(product._id)).stockQuantity).toBe(5);
	});

	it('refuses an over-cap cart on both order routes', async () => {
		const product = await makeProduct({ price: 10, stockQuantity: 500 });
		const items = [line(product, 100), line(product, 100), line(product, 1)];

		const online = await request(app).post('/api/orders').send({ ...customer, items, expectedTotal: 2010 });
		const counter = await request(app).post('/api/seller/orders/direct').set('Cookie', cookies).send({ items, expectedTotal: 2010 });

		expect(online.status).toBe(400);
		expect(online.body.code).toBe('CART_TOO_MANY_UNITS');
		expect(counter.status).toBe(400);
		expect(await Order.countDocuments({})).toBe(0);
	});

	it('an online-only combo does not discount a counter order, and preview and order agree', async () => {
		const a = await makeProduct({ category: 'lanyard', price: 100000, stockQuantity: 5 });
		const b = await makeProduct({ category: 'sticker', price: 50000, stockQuantity: 5 });
		await makeCombo({
			price: 120000,
			salesChannel: 'online',
			categoryRequirements: [{ category: 'lanyard', quantity: 1 }, { category: 'sticker', quantity: 1 }]
		});
		const items = [line(a), line(b)];

		const preview = await request(app).post('/api/combos/pricing').send({ items, channel: 'offline' });
		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items, expectedTotal: preview.body.data.totalAmount });

		expect(preview.body.data.totalAmount).toBe(150000);
		expect(res.status).toBe(201);
		expect(res.body.data.totalAmount).toBe(150000);
		expect(res.body.data.comboInfo).toBeNull();
	});
});
