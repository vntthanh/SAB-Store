const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeProduct, makeCombo } = require('../helpers/factories');
const { makeSlug } = require('../../utils/public-code');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');

function attachImport(app, cookies, payload) {
	return request(app)
		.post('/api/admin/database/import')
		.set('Cookie', cookies)
		.attach('dataFile', Buffer.from(JSON.stringify(payload)), { filename: 'backup.json', contentType: 'application/json' });
}

const productRecord = (overrides = {}) => ({ name: 'Imported', price: 1000, category: 'general', ...overrides });

describe('database export/import and public codes', () => {
	let app;
	let cookies;

	beforeAll(async () => {
		app = buildTestApp();
		await Promise.all([Product.init(), Combo.init()]);
	});

	beforeEach(async () => {
		({ cookies } = await makeAdminSession(app));
	});

	it('keeps codes through export, an empty database and import, and recomputes the slug', async () => {
		const product = await makeProduct({ name: 'Móc khoá SAB' });
		const combo = await makeCombo({ name: 'Combo Quà' });
		const exported = await request(app).get('/api/admin/database/export').set('Cookie', cookies);
		expect(exported.status).toBe(200);

		await Promise.all([Product.deleteMany({}), Combo.deleteMany({})]);
		// A slug in the file is never trusted.
		exported.body.data.products[0].slug = 'forged';

		const res = await attachImport(app, cookies, { data: exported.body.data });

		expect(res.status).toBe(200);
		expect(res.body.hasErrors).toBe(false);
		const restoredProduct = await Product.findById(product._id).lean();
		const restoredCombo = await Combo.findById(combo._id).lean();
		expect(restoredProduct.publicCode).toBe(product.publicCode);
		expect(restoredProduct.slug).toBe(makeSlug('Móc khoá SAB', product.publicCode));
		expect(restoredCombo.publicCode).toBe(combo.publicCode);
		expect(restoredCombo.slug).toBe(makeSlug('Combo Quà', combo.publicCode));
	});

	it('gives imported records without a code a fresh one', async () => {
		const res = await attachImport(app, cookies, { data: { products: [productRecord()], combos: [] } });

		expect(res.status).toBe(200);
		expect((await Product.findOne({ name: 'Imported' }).lean()).publicCode).toMatch(/^[2-9A-Z]{8}$/);
	});

	it('rejects a malformed or file-duplicated code before writing anything', async () => {
		const malformed = await attachImport(app, cookies, { data: { products: [productRecord({ publicCode: 'bad' })] } });
		const duplicated = await attachImport(app, cookies, {
			data: { products: [productRecord({ publicCode: 'ABCDEFGH' }), productRecord({ name: 'Other', publicCode: 'ABCDEFGH' })] }
		});

		expect(malformed.status).toBe(400);
		expect(duplicated.status).toBe(400);
		expect(await Product.countDocuments({})).toBe(0);
	});

	it('reports a code that already belongs to another product and still imports the rest', async () => {
		await makeProduct({ name: 'Owner', publicCode: 'ABCDEFGH' });

		const res = await attachImport(app, cookies, {
			data: { products: [productRecord({ name: 'Clash', publicCode: 'ABCDEFGH' }), productRecord({ name: 'Fine' })] }
		});

		expect(res.status).toBe(200);
		expect(res.body.results.products).toMatchObject({ imported: 1, errors: 1 });
		expect(res.body.errorDetails.products[0].error).toMatch(/Mã công khai ABCDEFGH đã thuộc sản phẩm khác/);
		expect(await Product.countDocuments({ name: 'Fine' })).toBe(1);
		expect(await Product.countDocuments({ name: 'Clash' })).toBe(0);
	});
});
