/**
 * Behaviour the shared-schema validation middleware promises beyond what the
 * golden fixture records: it never rewrites the request, so the handlers do the
 * trimming and number conversion themselves, and those conversions must still
 * reach what is stored.
 */
const express = require('express');
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const { expectedTotalFor } = require('../helpers/pricing');
const { applyPendingMovements } = require('../helpers/stock');
const { validateOrderUpdate, validatePasswordChange, trimText } = require('../../middleware/validation');
const { formatOrderPaymentDescription } = require('../../utils/paymentHelper');
const Order = require('../../models/Order');
const Settings = require('../../models/Settings');

const customer = {
	studentId: '24120001',
	fullName: 'Nguyen Van A',
	email: 'a@example.com',
	phoneNumber: '0987654321',
};

describe('validation middleware contract', () => {
	function echoApp() {
		const app = express();
		app.use(express.json());
		app.put('/orders/:id/status', validateOrderUpdate, (req, res) => res.json({ body: req.body }));
		return app;
	}

	it('hands the handler the body exactly as the client sent it', async () => {
		const sent = { status: 'paid', note: '  padded  ', transactionCode: null, isAdmin: true, totalAmount: 1 };

		const res = await request(echoApp())
			.put('/orders/507f1f77bcf86cd799439011/status')
			.send(sent);

		expect(res.status).toBe(200);
		expect(res.body.body).toEqual(sent);
	});

	it('answers 400 with the {message, errors} shape and does not reach the handler', async () => {
		const res = await request(echoApp()).put('/orders/not-an-id/status').send({ status: 'nope' });

		expect(res.status).toBe(400);
		expect(res.body).toEqual({
			message: 'Dữ liệu không hợp lệ',
			errors: [
				{ field: 'id', message: 'ID đơn hàng không hợp lệ', value: 'not-an-id' },
				{ field: 'status', message: 'Trạng thái không hợp lệ', value: 'nope' },
			],
		});
	});

	it('never echoes a rejected password back', async () => {
		const app = express();
		app.use(express.json());
		app.post('/change', validatePasswordChange, (req, res) => res.json({}));

		const res = await request(app).post('/change').send({ currentPassword: 7, newPassword: 'weakpass' });

		expect(res.status).toBe(400);
		expect(res.body.errors.length).toBeGreaterThan(0);
		for (const error of res.body.errors) expect(error).not.toHaveProperty('value');
		expect(JSON.stringify(res.body)).not.toContain('weakpass');
	});

	it('trimText trims strings, reads null as empty and leaves an absent value absent', () => {
		expect(trimText(undefined)).toBeUndefined();
		expect(trimText(null)).toBe('');
		expect(trimText('  a b  ')).toBe('a b');
		expect(trimText('')).toBe('');
	});
});

describe('handlers apply what validation no longer rewrites', () => {
	let app;
	let admin;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		admin = await makeAdminSession(app);
	});

	it('POST /api/orders accepts padded customer text and forwards it trimmed', async () => {
		await Settings.create({ bankNameId: 'MB', bankAccountId: '0123456789', prefixMessage: 'SAB' });
		const product = await makeProduct({ price: 10000, stockQuantity: 5 });
		const items = [{ productId: String(product._id), quantity: 1 }];
		const expectedTotal = await expectedTotalFor(items);

		const res = await request(app).post('/api/orders').send({
			studentId: ' 24120001 ',
			fullName: '  Nguyễn Văn A  ',
			email: ' a@example.com ',
			phoneNumber: ' 0987654321 ',
			additionalNote: '  giao trước 9h  ',
			items,
			expectedTotal,
		});

		expect(res.status).toBe(201);
		const order = await Order.findOne({ orderCode: res.body.data.orderCode }).lean();
		expect(order).toMatchObject({
			studentId: '24120001',
			fullName: 'Nguyễn Văn A',
			email: 'a@example.com',
			phoneNumber: '0987654321',
			additionalNote: 'giao trước 9h',
		});
		// The payment description is built from the values the handler holds, not
		// from the stored document.
		expect(res.body.data.paymentDescription).toBe(
			await formatOrderPaymentDescription(order.orderCode, '24120001', 'Nguyễn Văn A'),
		);
		expect(res.body.data.paymentDescription).not.toMatch(/\s{2,}/);
	});

	it('POST /api/orders refuses a name made only of spaces', async () => {
		const res = await request(app).post('/api/orders').send({
			...customer,
			fullName: '   ',
			items: [{ productId: '507f1f77bcf86cd799439011', quantity: 1 }],
			expectedTotal: 0,
		});

		expect(res.status).toBe(400);
		// Messages are in Vietnamese and all belong to fullName; how many rules
		// report is the schema's business.
		expect(res.body.errors.length).toBeGreaterThan(0);
		for (const error of res.body.errors) expect(error.field).toBe('fullName');
		expect(res.body.errors.map((e) => e.message)).toContain('Họ tên là bắt buộc');
		expect(await Order.countDocuments()).toBe(0);
	});

	async function placeOrder(price = 10000) {
		const product = await makeProduct({ price, stockQuantity: 0 });
		const items = [{ productId: String(product._id), quantity: 1 }];
		const res = await request(app)
			.post('/api/orders')
			.send({ ...customer, items, expectedTotal: await expectedTotalFor(items) });
		expect(res.status).toBe(201);
		await applyPendingMovements();
		return { product, order: await Order.findOne({ orderCode: res.body.data.orderCode }) };
	}

	it('PUT /api/admin/orders/:id/items takes digit strings and stores the trimmed reason', async () => {
		const { order } = await placeOrder();
		const other = await makeProduct({ price: 10000, stockQuantity: 0 });

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}/items`)
			.set('Cookie', admin.cookies)
			.send({
				items: [{ productId: String(other._id), quantity: '1' }],
				expectedRevision: '0',
				reason: '  Khách đổi màu  ',
			});

		expect(res.status).toBe(200);
		const stored = await Order.findById(order._id).lean();
		expect(stored.itemsRevision).toBe(1);
		expect(stored.items[0].quantity).toBe(1);
		expect(stored.itemsHistory[0].reason).toBe('Khách đổi màu');
	});

	it('PATCH /api/admin/orders/:id/notes stores trimmed notes', async () => {
		const { order } = await placeOrder();

		const res = await request(app)
			.patch(`/api/admin/orders/${order._id}/notes`)
			.set('Cookie', admin.cookies)
			.send({ additionalNote: '  khách hẹn 9h  ', note: '  gọi lại  ' });

		expect(res.status).toBe(200);
		const stored = await Order.findById(order._id).lean();
		expect(stored.additionalNote).toBe('khách hẹn 9h');
		expect(stored.internalNotes[0].note).toBe('gọi lại');
	});

	it('PUT /api/admin/orders/:id records a trimmed transaction code and note', async () => {
		const { order } = await placeOrder();

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', admin.cookies)
			.send({ status: 'paid', transactionCode: '  TX-42  ', note: '  đã nhận  ' });

		expect(res.status).toBe(200);
		const stored = await Order.findById(order._id).lean();
		expect(stored.transactionCode).toBe('TX-42');
		expect(stored.statusHistory.at(-1)).toMatchObject({ transactionCode: 'TX-42', note: 'đã nhận' });
	});

	it('POST /api/combos/pricing prices a digit-string quantity like the number', async () => {
		const product = await makeProduct({ price: 25000 });
		const price = (quantity) => request(app)
			.post('/api/combos/pricing')
			.send({ items: [{ productId: String(product._id), quantity }] });

		const asNumber = await price(2);
		const asString = await price('2');

		expect(asNumber.status).toBe(200);
		expect(asString.status).toBe(200);
		expect(asString.body.data.totalAmount).toBe(50000);
		expect(asString.body.data).toEqual(asNumber.body.data);
	});
});

describe('POST /api/seller/change-password', () => {
	const CURRENT = 'factory-test-password-1';
	let app;
	let admin;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		admin = await makeAdminSession(app);
	});

	const change = (body) => request(app)
		.post('/api/seller/change-password')
		.set('Cookie', admin.cookies)
		.send(body);

	it('stores the new password exactly as typed, spaces included', async () => {
		const typed = ' Zq9xK2mW4vB ';

		const res = await change({ currentPassword: CURRENT, newPassword: typed });
		expect(res.status).toBe(200);

		const exact = await request(app).post('/api/auth/sign-in/email').send({ email: admin.email, password: typed });
		expect(exact.status).toBe(200);
		const trimmed = await request(app)
			.post('/api/auth/sign-in/email')
			.send({ email: admin.email, password: typed.trim() });
		expect(trimmed.status).not.toBe(200);
	});

	it('compares the current password as typed, without trimming it', async () => {
		const res = await change({ currentPassword: ` ${CURRENT} `, newPassword: 'Zq9xK2mW4vB' });

		expect(res.status).not.toBe(200);
		const unchanged = await request(app)
			.post('/api/auth/sign-in/email')
			.send({ email: admin.email, password: CURRENT });
		expect(unchanged.status).toBe(200);
	});
});
