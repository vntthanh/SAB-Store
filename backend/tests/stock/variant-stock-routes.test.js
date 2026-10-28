/**
 * Stock per variant through the admin routes: an adjustment names the variant it
 * moves (a product without options may leave it out), the history labels each
 * movement with its variant, and reconcile finds a variant whose cache drifted
 * even when its product's total still adds up.
 */
const request = require('supertest');
const { v7: uuidv7 } = require('uuid');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const { insertRawProduct, findProduct } = require('../helpers/db');
const { applyPendingMovements } = require('../helpers/stock');
const { POSTGRES } = require('../helpers/backend');
const { generatePublicCode } = require('../../utils/public-code');

const prisma = () => require('../../lib/prisma').prisma;

async function sizedProduct() {
	const product = await insertRawProduct({ name: `Áo ${uuidv7()}`, publicCode: generatePublicCode(), withDefaultVariant: false });
	await prisma().productOption.create({ data: { productId: product._id, position: 0, name: 'Size', values: ['S', 'M'] } });
	const small = await prisma().productVariant.create({ data: { productId: product._id, position: 0, optionValues: ['S'] } });
	const medium = await prisma().productVariant.create({ data: { productId: product._id, position: 1, optionValues: ['M'] } });
	return { product, small, medium };
}

const variantStock = async (id) => (await prisma().productVariant.findUnique({ where: { id } })).stockQuantity;

describe.skipIf(!POSTGRES)('stock per variant through the admin routes', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	const adjust = (id, body) => request(app).post(`/api/admin/products/${id}/stock-adjustments`).set('Cookie', cookies).send(body);
	const history = (id, query = '') => request(app).get(`/api/admin/products/${id}/stock-movements${query}`).set('Cookie', cookies);

	it('adjusts the named variant and moves the product total with it', async () => {
		const { product, small, medium } = await sizedProduct();

		expect((await adjust(product._id, { mode: 'delta', value: 4, reason: 'nhập', variantId: medium.id })).status).toBe(202);
		expect((await adjust(product._id, { mode: 'target', value: 2, reason: 'kiểm', variantId: small.id })).status).toBe(202);
		await applyPendingMovements();

		expect(await variantStock(medium.id)).toBe(4);
		expect(await variantStock(small.id)).toBe(2);
		expect((await findProduct(product._id)).stockQuantity).toBe(6);
	});

	it('refuses an adjustment without a variant for a product with options, or with a variant of another product', async () => {
		const { product } = await sizedProduct();
		const other = await sizedProduct();

		const missing = await adjust(product._id, { mode: 'delta', value: 1, reason: 'x' });
		const foreign = await adjust(product._id, { mode: 'delta', value: 1, reason: 'x', variantId: other.small.id });
		const malformed = await adjust(product._id, { mode: 'delta', value: 1, reason: 'x', variantId: 'abc' });

		expect([missing, foreign, malformed].map((res) => [res.status, res.body.code, res.body.message])).toEqual([
			[400, 'STOCK_ADJUSTMENT_INVALID', 'Chọn phân loại cần điều chỉnh tồn kho'],
			[400, 'STOCK_ADJUSTMENT_INVALID', 'Phân loại không thuộc sản phẩm này'],
			[400, 'STOCK_ADJUSTMENT_INVALID', 'ID phân loại không hợp lệ']
		]);
		expect(await prisma().stockMovement.count({ where: { productId: product._id } })).toBe(0);
	});

	it('adjusts the default variant of a product without options when no variant is named', async () => {
		const product = await insertRawProduct({ stockQuantity: 0 });

		expect((await adjust(product._id, { mode: 'delta', value: 3, reason: 'x' })).status).toBe(202);
		await applyPendingMovements();

		const [variant] = await prisma().productVariant.findMany({ where: { productId: product._id } });
		expect(variant.stockQuantity).toBe(3);
		expect((await findProduct(product._id)).stockQuantity).toBe(3);
	});

	it('labels each movement with its variant and narrows the history to one variant', async () => {
		const { product, small, medium } = await sizedProduct();
		expect((await adjust(product._id, { mode: 'delta', value: 1, reason: 'a', variantId: small.id })).status).toBe(202);
		expect((await adjust(product._id, { mode: 'delta', value: 2, reason: 'b', variantId: medium.id })).status).toBe(202);

		const all = await history(product._id);
		const onlyMedium = await history(product._id, `?variantId=${medium.id}`);

		// Newest first.
		expect(all.body.data.map((row) => row.label)).toEqual(['M', 'S']);
		expect(onlyMedium.body.data).toEqual([expect.objectContaining({ variantId: medium.id, label: 'M', delta: 2 })]);
		expect(onlyMedium.body.meta.total).toBe(1);
		expect((await history(product._id, '?variantId=nope')).status).toBe(400);
		expect((await history(product._id, `?variantId=${medium.id}&variantId=${small.id}`)).status).toBe(400);
	});

	it('reports a variant whose cache drifted from its movements while the product total still adds up', async () => {
		const { product, small, medium } = await sizedProduct();
		const steady = await prisma().productVariant.create({ data: { productId: product._id, position: 2, optionValues: ['L'] } });
		await adjust(product._id, { mode: 'delta', value: 3, reason: 'x', variantId: small.id });
		await applyPendingMovements();
		// Units moved between variants behind the ledger's back: the product total is unchanged.
		await prisma().productVariant.update({ where: { id: small.id }, data: { stockQuantity: 1 } });
		await prisma().productVariant.update({ where: { id: medium.id }, data: { stockQuantity: 2 } });

		const res = await request(app).get('/api/admin/stock/reconcile').set('Cookie', cookies);

		expect(res.body.data).toEqual(expect.arrayContaining([
			expect.objectContaining({ productId: product._id, variantId: small.id, label: 'S', cached: 1, ledgerSum: 3, diff: -2 }),
			expect.objectContaining({ productId: product._id, variantId: medium.id, label: 'M', cached: 2, ledgerSum: 0, diff: 2 })
		]));
		expect(res.body.data.some((row) => row.productId === product._id && row.variantId === undefined)).toBe(false);
		expect(res.body.data.some((row) => row.variantId === steady.id)).toBe(false);
	});
});
