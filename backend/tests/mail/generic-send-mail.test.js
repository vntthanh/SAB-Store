/**
 * The generic mailer send: behind the master switch only, never throws, and the
 * transport it builds carries the DNS timeout.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const { MAIL_BODY, stubTransport } = require('../helpers/mail');
const { sendMail } = require('../../services/mailer');

const describePostgres = process.env.DATA_BACKEND === 'mongo' ? describe.skip : describe;

const message = { to: 'someone@example.com', subject: 'Mã đăng nhập', html: '<p>123456</p>', text: '123456' };

describePostgres('mailer sendMail', () => {
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

	const configure = async (patch = {}) => {
		const res = await request(app)
			.put('/api/admin/settings/mail')
			.set('Cookie', cookies)
			.send({ ...MAIL_BODY, host: `generic-smtp-${++hostCounter}.test.example`, ...patch });
		expect(res.status).toBe(200);
	};

	it('sends through the saved account even when both order-mail switches are off', async () => {
		await configure({ notifyOrderCreated: false, notifyStatusChanged: false });
		const { createTransport, sendMail: send } = stubTransport();

		await expect(sendMail(message)).resolves.toBe('sent');

		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toMatchObject({ to: message.to, subject: message.subject, html: message.html, text: message.text });
		expect(createTransport.mock.calls[0][0].dnsTimeout).toBe(15000);
	});

	it('skips without building a transport while the master switch is off', async () => {
		await configure({ enabled: false });
		const { createTransport } = stubTransport();

		await expect(sendMail(message)).resolves.toBe('skipped');

		expect(createTransport).not.toHaveBeenCalled();
	});

	it('skips a message with no recipient', async () => {
		await configure();
		const { createTransport } = stubTransport();

		await expect(sendMail({ ...message, to: '  ' })).resolves.toBe('skipped');

		expect(createTransport).not.toHaveBeenCalled();
	});

	it('reports failed instead of throwing, and logs no address', async () => {
		await configure();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		stubTransport({ sendMail: vi.fn().mockRejectedValue(Object.assign(new Error(`refused ${message.to}`), { code: 'ECONNECTION' })) });

		await expect(sendMail(message)).resolves.toBe('failed');

		const logged = JSON.stringify(errors.mock.calls);
		expect(logged).toContain('ECONNECTION');
		expect(logged).not.toContain(message.to);
	});
});
