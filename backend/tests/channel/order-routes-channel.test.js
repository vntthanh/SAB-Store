/**
 * Order routes enforce the sales channel of the flow they serve:
 * POST /api/orders is online, POST /api/seller/orders/direct is the counter.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');
const Order = require('../../models/Order');

function onlineOrderBody(items) {
	return {
		studentId: 'SV12345',
		fullName: 'Nguyen Van A',
		email: 'nguyenvana@example.com',
		phoneNumber: '0987654321',
		additionalNote: '',
		items
	};
}

const item = (product, quantity = 1) => ({ productId: product._id.toString(), quantity });

describe('POST /api/orders (online channel)', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('accepts an online-only product', async () => {
		const product = await makeProduct({ salesChannel: 'online', price: 30000 });

		const res = await request(app).post('/api/orders').send(onlineOrderBody([item(product, 2)]));

		expect(res.status).toBe(201);
		expect(res.body.data.totalAmount).toBe(60000);
	});

	it('rejects an offline-only product with 400 (never 500) and names it', async () => {
		const product = await makeProduct({ salesChannel: 'offline', name: 'Counter Only Keychain' });

		const res = await request(app).post('/api/orders').send(onlineOrderBody([item(product)]));

		expect(res.status).toBe(400);
		expect(res.body.success).toBe(false);
		expect(res.body.message).toContain('Counter Only Keychain');
		expect(await Order.countDocuments({})).toBe(0);
	});

	it('rejects an available:false product', async () => {
		const product = await makeProduct({ available: false });

		const res = await request(app).post('/api/orders').send(onlineOrderBody([item(product)]));

		expect(res.status).toBe(400);
	});

	it('does not apply an offline-only combo to an online order', async () => {
		const a = await makeProduct({ category: 'lanyard', price: 100000 });
		const b = await makeProduct({ category: 'sticker', price: 50000 });
		await makeCombo({
			price: 120000,
			salesChannel: 'offline',
			categoryRequirements: [
				{ category: 'lanyard', quantity: 1 },
				{ category: 'sticker', quantity: 1 }
			]
		});

		const res = await request(app).post('/api/orders').send(onlineOrderBody([item(a), item(b)]));

		expect(res.status).toBe(201);
		expect(res.body.data.totalAmount).toBe(150000);
	});
});

describe('POST /api/seller/orders/direct (offline channel)', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app)); // admin role passes authenticateSeller too
	});

	it('accepts an offline-only product and deducts its stock', async () => {
		const product = await makeProduct({ salesChannel: 'offline', price: 20000, stockQuantity: 5 });

		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [item(product, 2)] });

		expect(res.status).toBe(201);
		expect((await Product.findById(product._id)).stockQuantity).toBe(3);
	});

	it('rejects an online-only product with 400 naming it, and leaves stock untouched', async () => {
		const product = await makeProduct({ salesChannel: 'online', name: 'Web Exclusive Hoodie', stockQuantity: 5 });

		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [item(product)] });

		expect(res.status).toBe(400);
		expect(res.body.message).toContain('Web Exclusive Hoodie');
		expect((await Product.findById(product._id)).stockQuantity).toBe(5);
		expect(await Order.countDocuments({})).toBe(0);
	});

	it('rejects an available:false product (the POS no longer lists it either)', async () => {
		const product = await makeProduct({ available: false, stockQuantity: 5 });

		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [item(product)] });

		expect(res.status).toBe(400);
		expect((await Product.findById(product._id)).stockQuantity).toBe(5);
	});

	it('sells isActive:false when available:true (isActive is deprecated and unread)', async () => {
		const product = await makeProduct({ isActive: false, available: true, stockQuantity: 5 });

		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [item(product)] });

		expect(res.status).toBe(201);
	});

	it('discounts with an offline-only combo at the counter', async () => {
		const a = await makeProduct({ category: 'lanyard', price: 100000, stockQuantity: 5 });
		const b = await makeProduct({ category: 'sticker', price: 50000, stockQuantity: 5 });
		await makeCombo({
			price: 120000,
			salesChannel: 'offline',
			categoryRequirements: [
				{ category: 'lanyard', quantity: 1 },
				{ category: 'sticker', quantity: 1 }
			]
		});

		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [item(a), item(b)] });

		expect(res.status).toBe(201);
		expect(res.body.data.totalAmount).toBe(120000);
	});
});

describe('POST /api/admin/orders/direct', () => {
	it('no longer exists: the counter flow is POST /api/seller/orders/direct', async () => {
		const app = buildTestApp();
		const { cookies } = await makeAdminSession(app);
		const product = await makeProduct({ stockQuantity: 5 });

		const res = await request(app)
			.post('/api/admin/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [item(product)] });

		expect(res.status).toBe(404);
		expect((await Product.findById(product._id)).stockQuantity).toBe(5);
		expect(await Order.countDocuments({})).toBe(0);
	});
});
