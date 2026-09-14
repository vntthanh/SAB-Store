const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeProduct, makeCombo } = require('../helpers/factories');
const Order = require('../../models/Order');

// Q7 (plan.md, "Quyết định Phần B đã chốt"): the export endpoint is a bulk
// PII/credential egress path, so users and accounts must never appear in its
// output — not projected-down, not redacted, simply never queried. This
// stays true even though makeAdminSession() creates a real admin user +
// credential Account row in the same database the export reads from.
describe('GET /api/admin/database/export', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('contains products/combos/orders but never users or accounts, and never a password', async () => {
		const { cookies } = await makeAdminSession(app);
		await makeProduct();
		await makeCombo();
		await Order.create({
			orderCode: 'ORDEXP1',
			phoneNumber: '0911111111',
			studentId: 'SV002',
			fullName: 'Tran Thi B',
			email: 'b@test.com',
			items: [],
			totalAmount: 0,
			status: 'confirmed'
		});

		const res = await request(app)
			.get('/api/admin/database/export')
			.set('Cookie', cookies);

		expect(res.status).toBe(200);

		const body = res.body;
		expect(body.data).not.toHaveProperty('users');
		expect(body.data).not.toHaveProperty('accounts');
		expect(body.data).toHaveProperty('products');
		expect(body.data).toHaveProperty('combos');
		expect(body.data).toHaveProperty('orders');
		expect(body.data.orders).toHaveLength(1);
		expect(body.data.orders[0].orderCode).toBe('ORDEXP1');

		// Belt and suspenders: even if a future edit adds a field back, no
		// password/token material may ever reach the response body.
		const raw = JSON.stringify(body);
		expect(raw.toLowerCase()).not.toMatch(/password/);
		expect(raw.toLowerCase()).not.toMatch(/accesstoken|refreshtoken|idtoken/);

		expect(body.metadata.collections).not.toHaveProperty('users');
		expect(body.metadata.collections).not.toHaveProperty('accounts');
	});

	it('rejects an unauthenticated request', async () => {
		const res = await request(app).get('/api/admin/database/export');
		expect([401, 403]).toContain(res.status);
	});
});
