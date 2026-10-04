const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo } = require('../helpers/factories');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const Settings = require('../../models/Settings');
const { ogVersion, toPublicProduct } = require('../../services/public-catalog');

const BASE = process.env.BASE_URL;
const EXPECTED_TAGS = [
	'<title>', 'name="description"', 'rel="canonical"', 'property="og:type"', 'property="og:site_name"',
	'property="og:url"', 'property="og:title"', 'property="og:description"', 'property="og:image"',
	'property="og:image:width"', 'property="og:image:height"', 'property="og:image:type"',
	'property="og:image:alt"', 'property="og:locale"', 'name="twitter:card"', 'name="twitter:title"',
	'name="twitter:description"', 'name="twitter:image"'
];

const meta = (app, type, code) => request(app).get('/api/share/meta').query({ type, code });

describe('GET /api/share/meta', () => {
	let app;

	beforeAll(() => Promise.all([Product.init(), Combo.init()]));
	beforeEach(() => {
		app = buildTestApp();
	});
	afterEach(() => jest.restoreAllMocks());

	it('renders exactly the contract tag set for a public product', async () => {
		const product = await makeProduct({ salesChannel: 'online', name: 'Móc khoá', price: 25000, description: 'Xinh xắn' });

		const res = await meta(app, 'p', product.publicCode);

		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
		expect(res.headers['x-content-type-options']).toBe('nosniff');
		for (const tag of EXPECTED_TAGS) expect(res.text).toContain(tag);
		expect(res.text.match(/<meta |<link |<title>/g)).toHaveLength(EXPECTED_TAGS.length);
		expect(res.text).toContain(`<link rel="canonical" href="${BASE}/p/${product.publicCode}/${product.slug}" />`);
		expect(res.text).toContain(`content="${BASE}/p/${product.publicCode}/${product.slug}"`);
		expect(res.text).toContain('content="product"');
		expect(res.text).toContain('25.000đ · Xinh xắn');
		expect(res.text).toContain(`${BASE}/og/p/${product.publicCode}.jpg?v=${ogVersion(toPublicProduct(product))}`);
		expect(res.text.length).toBeLessThan(3072);
	});

	it('escapes markup in names and descriptions', async () => {
		const product = await makeProduct({ salesChannel: 'online', name: `Móc "khoá" <script>&'`, description: '<img src=x onerror=1>' });

		const res = await meta(app, 'p', product.publicCode);

		expect(res.status).toBe(200);
		expect(res.text).not.toContain('<script>');
		expect(res.text).not.toContain('<img');
		expect(res.text).toContain('&lt;script&gt;&amp;&#39;');
		expect(res.text).toContain('&quot;khoá&quot;');
	});

	it('cannot smuggle an SSI directive or close the comment through a combo name', async () => {
		const combo = await makeCombo({ name: 'Combo <!--# include virtual="/api/admin/orders" --> -->' });

		const res = await meta(app, 'c', combo.publicCode);

		expect(res.status).toBe(200);
		expect(res.text).not.toContain('<!--#');
		expect(res.text).not.toContain('-->');
		expect(res.text).toMatch(/\/og\/c\/[2-9A-HJKMNP-Z]{8}\.jpg\?v=[0-9a-f]{8}/);
	});

	it('builds absolute URLs from BASE_URL, never from the Host header', async () => {
		const product = await makeProduct({ salesChannel: 'online' });

		const res = await meta(app, 'p', product.publicCode).set('Host', 'evil.example');

		expect(res.status).toBe(200);
		expect(res.text).not.toContain('evil.example');
		const urls = res.text.match(/https?:\/\/[^"]+/g);
		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) expect(url.startsWith(BASE)).toBe(true);
	});

	it('answers an empty 404 for hidden, unknown and malformed requests', async () => {
		const hidden = await makeProduct({ available: false });
		const counterOnly = await makeProduct({ salesChannel: 'offline' });

		const responses = await Promise.all([
			meta(app, 'p', hidden.publicCode),
			meta(app, 'p', counterOnly.publicCode),
			meta(app, 'p', 'ZZZZZZZZ'),
			meta(app, 'x', hidden.publicCode),
			request(app).get('/api/share/meta'),
			request(app).get('/api/share/meta?type[]=p&code=ZZZZZZZZ')
		]);

		for (const res of responses) {
			expect(res.status).toBe(404);
			expect(res.text).toBe('');
		}
	});

	it('answers an empty 500, not the JSON error body, when the database fails', async () => {
		jest.spyOn(Product, 'findSellable').mockImplementation(() => {
			throw new Error('db down');
		});
		jest.spyOn(console, 'error').mockImplementation(() => {});

		const res = await meta(app, 'p', 'ABCDEFGH');

		expect(res.status).toBe(500);
		expect(res.text).toBe('');
	});

	it('uses Settings.storeTitle for the site name and title suffix, falling back to SAB Store', async () => {
		const product = await makeProduct({ salesChannel: 'online', name: 'Bút' });

		const fallback = await meta(app, 'p', product.publicCode);
		expect(fallback.text).toContain('<title>Bút — SAB Store</title>');
		expect(fallback.text).toContain('property="og:site_name" content="SAB Store"');

		await Settings.create({ key: Settings.SETTINGS_KEY, bankNameId: 'x', bankAccountId: 'y', storeTitle: 'Cửa hàng X' });
		const custom = await meta(app, 'p', product.publicCode);
		expect(custom.text).toContain('<title>Bút — Cửa hàng X</title>');
		expect(custom.text).toContain('property="og:site_name" content="Cửa hàng X"');
		expect(custom.text).toContain('property="og:title" content="Bút — Cửa hàng X"');
	});

	it('renders a combo as a website with its price, even without online products', async () => {
		const combo = await makeCombo({
			name: 'Combo vui', price: 99000, salesChannel: 'online',
			categoryRequirements: [{ category: 'ghost', quantity: 2 }]
		});

		const res = await meta(app, 'c', combo.publicCode);

		expect(res.status).toBe(200);
		expect(res.text).toContain('property="og:type" content="website"');
		expect(res.text).toContain('Combo 99.000đ');
		expect(res.text).toContain(`${BASE}/c/${combo.publicCode}/${combo.slug}`);
	});

	it('returns the same body whatever the User-Agent', async () => {
		const product = await makeProduct({ salesChannel: 'online' });

		const browser = await meta(app, 'p', product.publicCode).set('User-Agent', 'Mozilla/5.0 Chrome/120');
		const crawler = await meta(app, 'p', product.publicCode).set('User-Agent', 'facebookexternalhit/1.1');

		expect(crawler.text).toBe(browser.text);
	});
});
