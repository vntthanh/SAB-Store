/**
 * Order mail end to end: the admin saves SMTP settings through the API, then an
 * online order and an admin status change go through the real routes. The SMTP
 * transport is a stub, so nothing here opens a socket.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeProduct, makeOrder, makeSettings } = require('../helpers/factories');
const { MAIL_BODY, stubTransport, watchOrderMail } = require('../helpers/mail');

const customer = {
	studentId: '24120001',
	fullName: 'Nguyen Van A',
	email: 'a@example.com',
	phoneNumber: '0987654321'
};

describe('order mail', () => {
	let app;
	let cookies;
	let hostCounter = 0;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		({ cookies } = await makeAdminSession(app));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// The mailer keeps one transport per distinct account; a fresh host per test keeps a
	// stub from an earlier test from being reused.
	const configure = async (patch = {}) => {
		const res = await request(app)
			.put('/api/admin/settings/mail')
			.set('Cookie', cookies)
			.send({ ...MAIL_BODY, host: `smtp-${++hostCounter}.test.example`, ...patch });
		expect(res.status).toBe(200);
	};

	const placeOrder = async (extra = {}) => {
		await makeSettings({ bankNameId: 'MB', bankAccountId: '0123456789', prefixMessage: 'SAB', storeTitle: 'Cửa hàng thử' });
		const product = await makeProduct({ name: 'Áo <b>thun</b>', price: 10000, stockQuantity: 5 });
		const res = await request(app)
			.post('/api/orders')
			.send({ ...customer, items: [{ productId: String(product._id), quantity: 2 }], expectedTotal: 20000, ...extra });
		expect(res.status).toBe(201);
		return res.body.data;
	};

	const changeStatus = (order, body) =>
		request(app).put(`/api/admin/orders/${order._id}`).set('Cookie', cookies).send(body);

	describe('order confirmation', () => {
		it('sends exactly one escaped Vietnamese mail to the customer once the order is created', async () => {
			await configure();
			const { sendMail } = stubTransport();
			const mail = watchOrderMail();

			const created = await placeOrder();
			await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));

			expect(mail.read).toHaveBeenCalledTimes(1);
			const message = sendMail.mock.calls[0][0];
			expect(message.to).toBe('a@example.com');
			expect(message.from).toEqual({ name: MAIL_BODY.fromName, address: MAIL_BODY.fromAddress });
			expect(message.subject).toBe(`[Cửa hàng thử] Xác nhận đơn hàng ${created.orderCode}`);
			expect(message.text).toContain(created.orderCode);
			expect(message.text).toMatch(/Tổng cộng: 20\.000/);
			expect(message.html).toContain('Áo &lt;b&gt;thun&lt;/b&gt; × 2');
			expect(message.html).not.toContain('<b>thun</b>');
			expect(created.paymentDescription).toBeTruthy();
			expect(message.html).toContain(created.paymentDescription);
		});

		it('builds no transport and sends nothing while the master switch is off', async () => {
			await configure({ enabled: false });
			const { createTransport, sendMail } = stubTransport();
			const mail = watchOrderMail();

			await placeOrder();
			await mail.settled();

			expect(createTransport).not.toHaveBeenCalled();
			expect(sendMail).not.toHaveBeenCalled();
		});

		it('builds no transport when mail was never configured', async () => {
			const { createTransport } = stubTransport();
			const mail = watchOrderMail();

			await placeOrder();
			await mail.settled();

			expect(createTransport).not.toHaveBeenCalled();
		});

		it('sends nothing when the confirmation switch is off', async () => {
			await configure({ notifyOrderCreated: false });
			const { createTransport } = stubTransport();
			const mail = watchOrderMail();

			await placeOrder();
			await mail.settled();

			expect(createTransport).not.toHaveBeenCalled();
		});

		it('still creates the order when the SMTP server fails, and logs no address or password', async () => {
			await configure();
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
			stubTransport({ sendMail: vi.fn().mockRejectedValue(Object.assign(new Error(`refused ${customer.email} ${MAIL_BODY.pass}`), { code: 'ECONNECTION' })) });

			const created = await placeOrder();
			await vi.waitFor(() => expect(errors.mock.calls.some(([line]) => String(line).includes('Order mail'))).toBe(true));

			expect(created.orderCode).toBeTruthy();
			const logged = JSON.stringify(errors.mock.calls);
			expect(logged).toContain('ECONNECTION');
			expect(logged).not.toContain(customer.email);
			expect(logged).not.toContain(MAIL_BODY.pass);
		});
	});

	describe('status change', () => {
		it('sends one mail with the new status label on a real transition', async () => {
			await configure();
			const order = await makeOrder({ email: 'buyer@example.com' });
			const { sendMail } = stubTransport();
			const mail = watchOrderMail();

			const res = await changeStatus(order, { status: 'paid' });
			expect(res.status).toBe(200);
			await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));

			expect(mail.read).toHaveBeenCalledTimes(1);
			const message = sendMail.mock.calls[0][0];
			expect(message.to).toBe('buyer@example.com');
			expect(message.subject).toContain('Đã thanh toán');
			expect(message.subject).toContain(order.orderCode);
		});

		it('includes the escaped cancel reason when the order is cancelled', async () => {
			await configure();
			const order = await makeOrder({ email: 'buyer@example.com' });
			const { sendMail } = stubTransport();

			await changeStatus(order, { status: 'cancelled', cancelReason: 'Hết hàng <script>x</script>' });
			await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));

			const message = sendMail.mock.calls[0][0];
			expect(message.subject).toContain('Đã hủy');
			expect(message.text).toContain('Lý do: Hết hàng <script>x</script>');
			expect(message.html).toContain('Hết hàng &lt;script&gt;x&lt;/script&gt;');
			expect(message.html).not.toContain('<script>');
		});

		it('sends nothing for a refused same-status request', async () => {
			await configure();
			const order = await makeOrder({ email: 'buyer@example.com' });
			const { sendMail } = stubTransport();
			const mail = watchOrderMail();
			await changeStatus(order, { status: 'paid' });
			await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));

			const again = await changeStatus(order, { status: 'paid' });
			await mail.flushQueued();

			expect(again.status).toBe(409);
			expect(mail.read).toHaveBeenCalledTimes(1);
			expect(sendMail).toHaveBeenCalledTimes(1);
		});

		it('builds no transport while the master switch is off', async () => {
			await configure({ enabled: false });
			const order = await makeOrder({ email: 'buyer@example.com' });
			const { createTransport } = stubTransport();
			const mail = watchOrderMail();

			await changeStatus(order, { status: 'paid' });
			await mail.settled();

			expect(createTransport).not.toHaveBeenCalled();
		});

		it('builds no transport while the status-change switch is off', async () => {
			await configure({ notifyStatusChanged: false });
			const order = await makeOrder({ email: 'buyer@example.com' });
			const { createTransport } = stubTransport();
			const mail = watchOrderMail();

			await changeStatus(order, { status: 'paid' });
			await mail.settled();

			expect(createTransport).not.toHaveBeenCalled();
		});

		it('builds no transport for an order without a customer email', async () => {
			await configure();
			const order = await makeOrder({ email: '', isDirectSale: true });
			const { createTransport } = stubTransport();
			const mail = watchOrderMail();

			const res = await changeStatus(order, { status: 'paid' });
			await mail.flushQueued();

			expect(res.status).toBe(200);
			expect(mail.read).not.toHaveBeenCalled();
			expect(createTransport).not.toHaveBeenCalled();
		});
	});

	describe('a password that no longer decrypts', () => {
		it('leaves mail off and reports hasPassword false', async () => {
			await configure();
			const original = process.env.JWT_SECRET;
			process.env.JWT_SECRET = `${original}-rotated`;
			try {
				const { createTransport } = stubTransport();
				const mail = watchOrderMail();

				const status = await request(app).get('/api/admin/settings/mail').set('Cookie', cookies);
				await placeOrder();
				await mail.settled();

				expect(status.body.data.hasPassword).toBe(false);
				expect(createTransport).not.toHaveBeenCalled();
			} finally {
				process.env.JWT_SECRET = original;
			}
		});
	});
});
