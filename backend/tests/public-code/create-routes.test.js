const request = require('supertest');
const publicCode = require('../../utils/public-code');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const { findProduct, findCombo, countRows, failNextProductInsertAsRetryable } = require('../helpers/db');

const COLLIDING = 'AAAAAAAA';

describe('admin create routes assign public codes', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	afterEach(() => vi.restoreAllMocks());

	const createProduct = (body = {}) => request(app)
		.post('/api/admin/products')
		.set('Cookie', cookies)
		.send({ name: 'Móc khoá', price: 10000, category: 'general', stockQuantity: 5, ...body });

	it('POST product returns a code and slug', async () => {
		const res = await createProduct();

		expect(res.status).toBe(201);
		expect(res.body.data.product.publicCode).toMatch(publicCode.PUBLIC_CODE_PATTERN);
		expect(res.body.data.product.slug).toBe('moc-khoa');
	});

	it('POST product ignores a publicCode sent by the client', async () => {
		const res = await createProduct({ publicCode: 'ZZZZZZZZ', slug: 'evil' });

		expect(res.status).toBe(201);
		expect(res.body.data.product.publicCode).not.toBe('ZZZZZZZZ');
		expect(res.body.data.product.slug).toBe('moc-khoa');
	});

	it('POST product redoes the whole transaction with a new code after a collision', async () => {
		await makeProduct({ publicCode: COLLIDING });
		vi.spyOn(publicCode, 'generatePublicCode').mockReturnValueOnce(COLLIDING);

		const res = await createProduct();

		expect(res.status).toBe(201);
		expect(res.body.data.product.publicCode).not.toBe(COLLIDING);
		expect(await countRows('product')).toBe(2);
		// The aborted attempt left no opening movement behind.
		expect(await countRows('movement', { type: 'opening' })).toBe(1);
	});

	it('POST product gives up after 5 collisions and leaves nothing half-written', async () => {
		await makeProduct({ publicCode: COLLIDING });
		const spy = vi.spyOn(publicCode, 'generatePublicCode').mockReturnValue(COLLIDING);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await createProduct();

		expect(res.status).toBe(400);
		expect(spy).toHaveBeenCalledTimes(5);
		expect(await countRows('product')).toBe(1);
		expect(await countRows('movement')).toBe(0);
	});

	it('POST product draws a fresh code when the driver reruns the transaction callback', async () => {
		const draws = [];
		const realGenerate = publicCode.generatePublicCode;
		vi.spyOn(publicCode, 'generatePublicCode').mockImplementation(() => {
			const code = realGenerate();
			draws.push(code);
			return code;
		});
		// The first attempt completes its write, then fails the way a transient
		// transaction error does, so the driver reruns the callback.
		const retryable = failNextProductInsertAsRetryable();

		const res = await createProduct();

		expect(res.status).toBe(201);
		expect(retryable.fired()).toBe(true);
		expect(draws).toHaveLength(2);
		expect(draws[0]).not.toBe(draws[1]);
		expect(res.body.data.product.publicCode).toBe(draws[1]);
		expect(await countRows('product')).toBe(1);
		expect(await countRows('movement', { type: 'opening' })).toBe(1);
	});

	it('PUT product keeps its code even when the body carries another', async () => {
		const product = await makeProduct();

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ publicCode: 'ZZZZZZZZ', name: 'Tên mới' });

		expect(res.status).toBe(200);
		const stored = await findProduct(product._id);
		expect(stored.publicCode).toBe(product.publicCode);
		expect(stored.slug).toBe('ten-moi');
	});

	it('POST combo returns a code and slug; the client cannot choose them', async () => {
		await makeProduct({ category: 'general' });

		const res = await request(app)
			.post('/api/combos')
			.set('Cookie', cookies)
			.send({
				name: 'Combo Quà', price: 1000, publicCode: 'ZZZZZZZZ',
				categoryRequirements: [{ category: 'general', quantity: 1 }]
			});

		expect(res.status).toBe(201);
		expect(res.body.data.combo.publicCode).toMatch(publicCode.PUBLIC_CODE_PATTERN);
		expect(res.body.data.combo.publicCode).not.toBe('ZZZZZZZZ');
		expect(res.body.data.combo.slug).toBe('combo-qua');
	});

	it('PUT combo renames the slug through save()', async () => {
		const combo = await makeCombo({ name: 'Combo cũ' });

		const res = await request(app)
			.put(`/api/combos/${combo._id}`)
			.set('Cookie', cookies)
			.send({ name: 'Combo mới' });

		expect(res.status).toBe(200);
		const stored = await findCombo(combo._id);
		expect(stored.slug).toBe('combo-moi');
		expect(stored.publicCode).toBe(combo.publicCode);
	});
});
