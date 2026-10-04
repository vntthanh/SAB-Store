const { Readable } = require('stream');
const request = require('supertest');
const sharp = require('sharp');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo } = require('../helpers/factories');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const minio = require('../../lib/minio');
const { ogVersion, findPublicProductByCode, findPublicComboByCode } = require('../../services/public-catalog');

jest.setTimeout(20000);

const png = (size = 800) => sharp({ create: { width: size, height: size, channels: 3, background: '#cc3333' } }).png().toBuffer();

const collectBody = (res, callback) => {
	const chunks = [];
	res.on('data', (chunk) => chunks.push(chunk));
	res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const stubMinio = (buffer, { size = buffer.length } = {}) => {
	jest.spyOn(minio, 'getFileMetadata').mockResolvedValue({ size });
	return jest.spyOn(minio, 'getFile').mockImplementation(async () => Readable.from([buffer]));
};

const expectCompositedJpeg = async (res) => {
	expect(res.status).toBe(200);
	expect(res.headers['content-type']).toBe('image/jpeg');
	expect(res.headers['cache-control']).toBe('public, max-age=86400');
	const info = await sharp(res.body).metadata();
	expect([info.format, info.width, info.height]).toEqual(['jpeg', 1200, 630]);
};

describe('GET /api/share/image/:type/:code.jpg', () => {
	let app;

	beforeAll(() => Promise.all([Product.init(), Combo.init()]));
	beforeEach(() => {
		app = buildTestApp();
		jest.spyOn(console, 'warn').mockImplementation(() => {});
		jest.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => jest.restoreAllMocks());

	const fetchImage = (type, code, version) => request(app)
		.get(`/api/share/image/${type}/${code}.jpg`)
		.query({ v: version })
		.buffer(true)
		.parse(collectBody);

	const productImage = async (product) => {
		const version = ogVersion(await findPublicProductByCode(product.publicCode));
		return fetchImage('p', product.publicCode, version);
	};

	const comboImage = async (combo) => {
		const version = ogVersion(await findPublicComboByCode(combo.publicCode));
		return fetchImage('c', combo.publicCode, version);
	};

	it('renders a 1200x630 JPEG under 300 KB for the current version', async () => {
		const product = await makeProduct({ salesChannel: 'online', imageUrl: '/uploads/products/a.png' });
		const getFile = stubMinio(await png());

		const res = await productImage(product);

		await expectCompositedJpeg(res);
		expect(res.body.length).toBeLessThan(300 * 1024);
		expect(getFile).toHaveBeenCalledWith('products/a.png');
	});

	it('answers an empty 404 for a wrong version or a hidden product without touching storage', async () => {
		const product = await makeProduct({ salesChannel: 'online', imageUrl: '/uploads/products/a.png' });
		const hidden = await makeProduct({ available: false, imageUrl: '/uploads/products/b.png' });
		const getFile = stubMinio(await png());

		const wrongVersion = await fetchImage('p', product.publicCode, 'deadbeef');
		const missingVersion = await request(app).get(`/api/share/image/p/${product.publicCode}.jpg`);
		const hiddenProduct = await fetchImage('p', hidden.publicCode, 'deadbeef');

		for (const res of [wrongVersion, missingVersion, hiddenProduct]) {
			expect(res.status).toBe(404);
			expect(res.body.length || res.text || 0).toBe(0);
		}
		expect(getFile).not.toHaveBeenCalled();
		expect(minio.getFileMetadata).not.toHaveBeenCalled();
	});

	it('falls back to the stock picture when storage fails', async () => {
		jest.spyOn(minio, 'getFileMetadata').mockRejectedValue(new Error('storage down'));
		const product = await makeProduct({ salesChannel: 'online', imageUrl: '/uploads/products/a.png' });

		await expectCompositedJpeg(await productImage(product));
	});

	it('falls back to the stock picture when the file is over 10 MB, without downloading it', async () => {
		const getFile = stubMinio(Buffer.alloc(10), { size: 11 * 1024 * 1024 });
		const product = await makeProduct({ salesChannel: 'online', imageUrl: '/uploads/products/big.png' });

		await expectCompositedJpeg(await productImage(product));
		expect(getFile).not.toHaveBeenCalled();
	});

	it('never fetches an external image URL', async () => {
		const getFile = stubMinio(Buffer.alloc(10));
		const product = await makeProduct({ salesChannel: 'online', imageUrl: 'http://169.254.169.254/latest' });

		await expectCompositedJpeg(await productImage(product));
		expect(getFile).not.toHaveBeenCalled();
		expect(minio.getFileMetadata).not.toHaveBeenCalled();
	});

	it('falls back to the stock picture when the stored file is not an image', async () => {
		stubMinio(Buffer.from('not an image'));
		const product = await makeProduct({ salesChannel: 'online', imageUrl: '/uploads/products/a.png' });

		await expectCompositedJpeg(await productImage(product));
	});

	it('falls back to the stock picture when storage never answers', async () => {
		jest.spyOn(minio, 'getFileMetadata').mockImplementation(() => new Promise(() => {}));
		const product = await makeProduct({ salesChannel: 'online', imageUrl: '/uploads/products/slow.png' });

		await expectCompositedJpeg(await productImage(product));
	});

	it('composes a combo from the photos of its products', async () => {
		for (let i = 0; i < 3; i++) await makeProduct({ salesChannel: 'online', imageUrl: `/uploads/products/${i}.png` });
		const combo = await makeCombo({ salesChannel: 'online' });
		const getFile = stubMinio(await png());

		await expectCompositedJpeg(await comboImage(combo));
		expect(getFile).toHaveBeenCalledTimes(3);
	});

	it('renders a combo with no online products from the stock picture', async () => {
		const combo = await makeCombo({ salesChannel: 'online', categoryRequirements: [{ category: 'ghost', quantity: 1 }] });

		await expectCompositedJpeg(await comboImage(combo));
	});

	it('renders one image at a time and answers 503 once the queue is full', async () => {
		const source = await png();
		let inFlight = 0;
		let peak = 0;
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		// The first render is held open by the gate, so the only response that can
		// arrive before release() is the one refused because the queue is full.
		jest.spyOn(minio, 'getFileMetadata').mockImplementation(async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await gate;
			inFlight -= 1;
			return { size: source.length };
		});
		jest.spyOn(minio, 'getFile').mockImplementation(async () => Readable.from([source]));
		const product = await makeProduct({ salesChannel: 'online', imageUrl: '/uploads/products/a.png' });
		const version = ogVersion(await findPublicProductByCode(product.publicCode));

		const pending = [1, 2, 3, 4].map(() => fetchImage('p', product.publicCode, version));
		const first = await Promise.race(pending);
		release();
		const responses = await Promise.all(pending);

		expect(first.status).toBe(503);
		expect(peak).toBe(1);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 503]);
	});
});
