const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct } = require('../helpers/factories');
const Product = require('../../models/Product');

const PUBLIC_KEYS = [
	'_id', 'publicCode', 'slug', 'path', 'name', 'description', 'price', 'imageUrl',
	'category', 'available', 'minOrderQuantity', 'maxOrderQuantity'
].sort();
const FORBIDDEN_KEYS = [
	'salePrice', 'tags', 'weight', 'dimensions', 'sku', 'stockQuantity', 'inStock', 'isActive', 'currentPrice', 'onSale'
];

const withoutTimestamp = (body) => ({ ...body, error: { ...body.error, timestamp: undefined } });

describe('GET /api/products/by-code/:code and /api/products/:id', () => {
	let app;

	beforeAll(() => Product.init());
	beforeEach(() => {
		app = buildTestApp();
	});

	let skuSeq = 0;
	// Internal fields filled in so the test proves they are stripped; SKU is unique.
	const richProduct = (overrides = {}) => makeProduct({
		salesChannel: 'online', sku: `SKU-${++skuSeq}`, salePrice: 10, tags: ['t'], weight: 2, dimensions: { length: 1 }, stockQuantity: 7, ...overrides
	});

	it('returns the public shape for a product sold online', async () => {
		const product = await richProduct();

		const res = await request(app).get(`/api/products/by-code/${product.publicCode}`);

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(Object.keys(res.body.data).sort()).toEqual(PUBLIC_KEYS);
		expect(res.body.data.path).toBe(`/p/${product.publicCode}/${product.slug}`);
		expect(res.headers['cache-control']).toBe('public, max-age=60');
	});

	it('finds the product from a lower-case code with surrounding spaces', async () => {
		const product = await richProduct();

		const res = await request(app).get(`/api/products/by-code/${encodeURIComponent(` ${product.publicCode.toLowerCase()} `)}`);

		expect(res.status).toBe(200);
		expect(res.body.data._id).toBe(product._id.toString());
	});

	it('answers the same 404 for stopped, counter-only, unknown and injected codes', async () => {
		const stopped = await richProduct({ available: false });
		const counterOnly = await richProduct({ salesChannel: 'offline' });

		const responses = await Promise.all([
			request(app).get(`/api/products/by-code/${stopped.publicCode}`),
			request(app).get(`/api/products/by-code/${counterOnly.publicCode}`),
			request(app).get('/api/products/by-code/ZZZZZZZZ'),
			request(app).get('/api/products/by-code/%24ne')
		]);

		for (const res of responses) expect(res.status).toBe(404);
		const [first, ...rest] = responses.map((res) => withoutTimestamp(res.body));
		for (const body of rest) expect(body).toEqual(first);
	});

	it('ignores tracking query parameters', async () => {
		const product = await richProduct();

		const res = await request(app).get(`/api/products/by-code/${product.publicCode}?zarsrc=30&utm_source=zalo&fbclid=x`);

		expect(res.status).toBe(200);
		expect(res.body.data.publicCode).toBe(product.publicCode);
	});

	it('serves GET /:id in exactly the by-code shape, with no internal fields', async () => {
		const product = await richProduct();

		const byId = await request(app).get(`/api/products/${product._id}`);
		const byCode = await request(app).get(`/api/products/by-code/${product.publicCode}`);

		expect(byId.status).toBe(200);
		expect(Object.keys(byId.body.data).sort()).toEqual(PUBLIC_KEYS);
		expect(byId.body.data).toEqual(byCode.body.data);
		for (const key of FORBIDDEN_KEYS) expect(byId.body.data).not.toHaveProperty(key);
	});

	it('answers GET /:id with the by-code 404 for stopped, counter-only, unknown and malformed ids', async () => {
		const stopped = await richProduct({ available: false });
		const counterOnly = await richProduct({ salesChannel: 'offline' });
		const reference = await request(app).get('/api/products/by-code/ZZZZZZZZ');

		const responses = await Promise.all([
			request(app).get(`/api/products/${stopped._id}`),
			request(app).get(`/api/products/${counterOnly._id}`),
			request(app).get('/api/products/507f1f77bcf86cd799439011'),
			request(app).get('/api/products/not-an-id')
		]);

		for (const res of responses) {
			expect(res.status).toBe(404);
			expect(withoutTimestamp(res.body).error.message).toBe(withoutTimestamp(reference.body).error.message);
		}
	});

	it('exposes no stock field anywhere in the responses', async () => {
		const product = await richProduct();

		const bodies = [
			(await request(app).get(`/api/products/by-code/${product.publicCode}`)).body,
			(await request(app).get(`/api/products/${product._id}`)).body
		];

		for (const body of bodies) {
			const text = JSON.stringify(body);
			for (const key of ['stockQuantity', 'inStock']) expect(text).not.toContain(key);
		}
	});
});
