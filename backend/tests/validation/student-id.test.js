const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct } = require('../helpers/factories');
const { STUDENT_ID_PATTERN } = require('../../utils/student-id');

describe('student ID (MSSV) rule', () => {
	it('accepts 8 digits from K16 to K26, including K26', () => {
		for (const id of ['16000001', '19999999', '20123456', '25123456', '26123456']) {
			expect(STUDENT_ID_PATTERN.test(id)).toBe(true);
		}
	});

	it('rejects other intakes, a leading zero, non-digits and wrong lengths', () => {
		for (const id of ['', '15123456', '27123456', '06123456', '2612345', '261234567', '2612345678', 'SV261234', '2612 3456', ' 26123456x']) {
			expect(STUDENT_ID_PATTERN.test(id)).toBe(false);
		}
	});

	describe('POST /api/orders', () => {
		let app;
		beforeAll(() => {
			app = buildTestApp();
		});

		const body = (studentId, productId) => ({
			studentId,
			fullName: 'Sinh Vien Khoa Moi',
			email: 'k26@example.com',
			phoneNumber: '0901234567',
			items: [{ productId, quantity: 1 }],
			expectedTotal: 50000,
		});

		it('creates an order for a K26 student', async () => {
			const product = await makeProduct({ price: 50000, salesChannel: 'all' });
			const res = await request(app).post('/api/orders').send(body(' 26123456 ', String(product._id)));
			expect(res.status).toBe(201);
			const Order = require('../../models/Order');
			expect((await Order.findOne({}).lean()).studentId).toBe('26123456');
		});

		it('rejects a non-numeric student ID with a clear message', async () => {
			const product = await makeProduct({ price: 50000, salesChannel: 'all' });
			const res = await request(app).post('/api/orders').send(body('SV123', String(product._id)));
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).toContain('8 chữ số');
		});
	});
});
