/**
 * Status-change mail from the seller route, through the real route and a stubbed SMTP
 * transport (no socket is opened).
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeSellerSession, makeOrder } = require('../helpers/factories');
const { MAIL_BODY, stubTransport, watchOrderMail } = require('../helpers/mail');

const describePostgres = process.env.DATA_BACKEND === 'mongo' ? describe.skip : describe;

describePostgres('seller status-change mail', () => {
	let app;
	let adminCookies;
	let sellerCookies;
	let hostCounter = 0;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		({ cookies: adminCookies } = await makeAdminSession(app));
		({ cookies: sellerCookies } = await makeSellerSession(app));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A fresh host per test keeps the mailer from reusing an earlier test's stub transport.
	const configure = async (patch = {}) => {
		const res = await request(app)
			.put('/api/admin/settings/mail')
			.set('Cookie', adminCookies)
			.send({ ...MAIL_BODY, host: `seller-smtp-${++hostCounter}.test.example`, ...patch });
		expect(res.status).toBe(200);
	};

	const changeStatus = (order, body) =>
		request(app).put(`/api/seller/orders/${order._id}/status`).set('Cookie', sellerCookies).send(body);

	it('sends one mail with the new status after the change is stored', async () => {
		await configure();
		const order = await makeOrder({ email: 'buyer@example.com' });
		const { orders } = require('../../data');
		let statusWhenSent;
		const sendMail = vi.fn(async () => {
			statusWhenSent = (await orders.findDetail(String(order._id), { complete: true })).status;
			return { messageId: 'stub' };
		});
		stubTransport({ sendMail });
		const mail = watchOrderMail();

		const res = await changeStatus(order, { status: 'paid' });
		expect(res.status).toBe(200);
		await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
		await mail.flushQueued();

		expect(sendMail).toHaveBeenCalledTimes(1);
		// The stub reads the order after it is called; wait for that read instead of racing it.
		await vi.waitFor(() => expect(statusWhenSent).toBe('paid'));
		const message = sendMail.mock.calls[0][0];
		expect(message.to).toBe('buyer@example.com');
		expect(message.subject).toContain('Đã thanh toán');
		expect(message.subject).toContain(order.orderCode);
	});

	it.each([
		['the master switch', { enabled: false }],
		['the status-change switch', { notifyStatusChanged: false }]
	])('builds no transport while %s is off', async (_name, patch) => {
		await configure(patch);
		const order = await makeOrder({ email: 'buyer@example.com' });
		const { createTransport } = stubTransport();
		const mail = watchOrderMail();

		const res = await changeStatus(order, { status: 'paid' });
		await mail.settled();

		expect(res.status).toBe(200);
		expect(createTransport).not.toHaveBeenCalled();
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

	it('sends nothing for an order that is already final', async () => {
		await configure();
		const order = await makeOrder({ email: 'buyer@example.com', status: 'cancelled' });
		const { createTransport } = stubTransport();
		const mail = watchOrderMail();

		const res = await changeStatus(order, { status: 'paid' });
		await mail.flushQueued();

		expect(res.status).toBe(409);
		expect(mail.read).not.toHaveBeenCalled();
		expect(createTransport).not.toHaveBeenCalled();
	});
});
