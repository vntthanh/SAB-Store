/**
 * Options, variants and the gallery through the admin product routes: a variant
 * keeps its id (so its stock and history) while its combination survives an
 * edit, a variant with history is archived instead of deleted, opening stock is
 * recorded per variant, and an image nothing shows any more is deleted from
 * storage after the change commits.
 */
const request = require('supertest');
const minio = require('../../lib/minio');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const { findProduct } = require('../helpers/db');
const { applyPendingMovements } = require('../helpers/stock');
const { reconcile } = require('../../services/stock-ledger');
const { optionCombinations } = require('@sab/shared');

const prisma = () => require('../../lib/prisma').prisma;

describe('product options and variants through the admin routes', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
		vi.spyOn(minio, 'deleteFile').mockResolvedValue(undefined);
	});

	const every = (options, extra = () => ({})) => optionCombinations(options).map((optionValues) => ({ optionValues, ...extra(optionValues) }));
	const create = (body) => request(app).post('/api/admin/products').set('Cookie', cookies).send({ name: `Áo ${Date.now()}${Math.random()}`, price: 10000, category: 'ao', ...body });
	const update = (id, body) => request(app).put(`/api/admin/products/${id}`).set('Cookie', cookies).send(body);
	const variantsOf = async (id) => (await request(app).get(`/api/admin/products?limit=100`).set('Cookie', cookies)).body.data.find((row) => row._id === id).variants;
	const byLabel = (variants) => Object.fromEntries(variants.map((variant) => [variant.label ?? '', variant]));

	const colors = { name: 'Màu', values: ['Đỏ', 'Xanh'] };
	const skuSuffix = Date.now();
	const sizes = { name: 'Size', values: ['S', 'M', 'L'] };

	it('creates every combination with its own opening stock, price and image, the product holding the sum', async () => {
		const res = await create({
			images: ['/uploads/products/a.jpg', '/uploads/products/b.jpg'],
			options: [colors, sizes],
			variants: every([colors, sizes], ([color, size]) => ({
				openingStock: size === 'S' ? 2 : 1,
				...(size === 'L' && { price: 12000 }),
				...(color === 'Xanh' && { imageUrl: '/uploads/products/b.jpg' })
			}))
		});

		expect(res.status).toBe(201);
		const { product } = res.body.data;
		expect(product.imageUrl).toBe('/uploads/products/a.jpg');
		expect(product.options).toEqual([{ name: 'Màu', values: ['Đỏ', 'Xanh'] }, { name: 'Size', values: ['S', 'M', 'L'] }]);
		const variants = byLabel(product.variants);
		expect(Object.keys(variants).sort()).toEqual(['Xanh / L', 'Xanh / M', 'Xanh / S', 'Đỏ / L', 'Đỏ / M', 'Đỏ / S'].sort());
		expect(variants['Đỏ / L']).toMatchObject({ price: 12000, effectivePrice: 12000, stockQuantity: 1 });
		expect(variants['Xanh / S']).toMatchObject({ effectivePrice: 10000, stockQuantity: 2, imageUrl: '/uploads/products/b.jpg' });
		expect((await findProduct(product._id)).stockQuantity).toBe(8);
		expect(await prisma().stockMovement.count({ where: { productId: product._id, type: 'opening', status: 'applied' } })).toBe(6);
		expect(await reconcile()).toEqual([]);
	});

	it('keeps ids and stock through a rename, archives a removed value that has history and deletes one that has none', async () => {
		const created = (await create({ options: [sizes], variants: every([sizes], ([size]) => ({ openingStock: size === 'M' ? 3 : 0 })) })).body.data.product;
		const before = byLabel(created.variants);

		// S renamed to XS, M removed (it has its opening movement), L removed (no history), XL added.
		const res = await update(created._id, {
			options: [{ name: 'Cỡ', previousName: 'Size', values: ['XS', 'XL'], previousValues: ['S', null] }],
			variants: [{ optionValues: ['XS'] }, { optionValues: ['XL'] }]
		});

		expect(res.status).toBe(200);
		const after = byLabel(res.body.data.product.variants);
		expect(after.XS._id).toBe(before.S._id);
		expect(after.XL).toMatchObject({ isActive: true, stockQuantity: 0 });
		expect(after.XL._id).not.toBe(before.L._id);
		expect(after.M).toMatchObject({ _id: before.M._id, isActive: false, stockQuantity: 3 });
		expect(after.M.archivedAt).toBeDefined();
		expect(after.L).toBeUndefined();
		expect(await prisma().productVariant.findUnique({ where: { id: before.L._id } })).toBeNull();
		expect((await findProduct(created._id)).stockQuantity).toBe(3);
		expect(await reconcile()).toEqual([]);

		// Offering M again restores the archived variant with its id and stock.
		const restored = await update(created._id, {
			options: [{ name: 'Cỡ', previousName: 'Cỡ', values: ['XS', 'XL', 'M'], previousValues: ['XS', 'XL', null] }],
			variants: [{ optionValues: ['XS'] }, { optionValues: ['XL'] }, { optionValues: ['M'] }]
		});
		expect(restored.status).toBe(200);
		expect(byLabel(restored.body.data.product.variants).M).toMatchObject({ _id: before.M._id, isActive: true, stockQuantity: 3 });
	});

	it('gives existing variants the first value of an added option, so a product without options keeps its stock', async () => {
		const created = (await create({ stockQuantity: 5 })).body.data.product;
		const [defaultVariant] = created.variants;

		const res = await update(created._id, { options: [sizes], variants: every([sizes]) });

		expect(res.status).toBe(200);
		expect(byLabel(res.body.data.product.variants).S).toMatchObject({ _id: defaultVariant._id, stockQuantity: 5 });
		expect(await reconcile()).toEqual([]);
	});

	it('refuses a rename onto the combination an archived variant holds', async () => {
		const created = (await create({ options: [sizes], variants: every([sizes], ([size]) => ({ openingStock: size === 'M' ? 1 : 0 })) })).body.data.product;
		await update(created._id, { options: [{ name: 'Size', values: ['S', 'L'], previousValues: ['S', 'L'] }], variants: [{ optionValues: ['S'] }, { optionValues: ['L'] }] });

		const res = await update(created._id, { options: [{ name: 'Size', values: ['M', 'L'], previousValues: ['S', 'L'] }], variants: [{ optionValues: ['M'] }, { optionValues: ['L'] }] });

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/"M".*đã lưu trữ/);
		// Nothing of the refused edit stays.
		const stored = await prisma().productOption.findMany({ where: { productId: created._id } });
		expect(stored.map((option) => option.values)).toEqual([['S', 'L']]);
	});

	it('folds variants onto the remaining option when an option type is removed, archiving the ones with history', async () => {
		const created = (await create({ options: [colors, sizes], variants: every([colors, sizes], () => ({ openingStock: 1 })) })).body.data.product;
		const before = byLabel(created.variants);

		const res = await update(created._id, { options: [{ ...sizes, previousName: 'Size', previousValues: sizes.values }], variants: every([sizes]) });

		expect(res.status).toBe(200);
		const after = res.body.data.product.variants;
		const active = byLabel(after.filter((variant) => variant.isActive));
		expect(Object.keys(active).sort()).toEqual(['L', 'M', 'S']);
		expect(active.S._id).toBe(before['Đỏ / S']._id);
		expect(after.filter((variant) => !variant.isActive).map((variant) => variant._id).sort())
			.toEqual(['Xanh / S', 'Xanh / M', 'Xanh / L'].map((label) => before[label]._id).sort());
		expect((await findProduct(created._id)).stockQuantity).toBe(6);
		expect(await reconcile()).toEqual([]);
	});

	it('swaps two value labels without losing which variant holds which stock', async () => {
		const created = (await create({ options: [sizes], variants: every([sizes], ([size]) => ({ openingStock: size === 'S' ? 5 : 1 })) })).body.data.product;
		const before = byLabel(created.variants);

		const res = await update(created._id, {
			options: [{ name: 'Size', values: ['M', 'S', 'L'], previousValues: ['S', 'M', 'L'] }],
			variants: every([{ name: 'Size', values: ['M', 'S', 'L'] }])
		});

		expect(res.status).toBe(200);
		const after = byLabel(res.body.data.product.variants);
		expect(after.M).toMatchObject({ _id: before.S._id, stockQuantity: 5 });
		expect(after.S).toMatchObject({ _id: before.M._id, stockQuantity: 1 });
	});

	it('archives a removed variant that was sold even though its stock never moved', async () => {
		const { makeOrder } = require('../helpers/factories');
		const created = (await create({ options: [sizes], variants: every([sizes]) })).body.data.product;
		const medium = byLabel(created.variants).M;
		await makeOrder({ items: [{ productId: created._id, variantId: medium._id, variantLabel: 'M', productName: created.name, price: 10000, quantity: 1 }], totalAmount: 10000 });

		const res = await update(created._id, { options: [{ name: 'Size', values: ['S', 'L'], previousValues: ['S', 'L'] }], variants: [{ optionValues: ['S'] }, { optionValues: ['L'] }] });

		expect(res.status).toBe(200);
		expect(byLabel(res.body.data.product.variants).M).toMatchObject({ _id: medium._id, isActive: false });
	});

	it('refuses a variant image outside the gallery and a gallery change that drops an image a variant shows', async () => {
		const created = (await create({ images: ['/uploads/products/a.jpg'], options: [sizes], variants: every([sizes], ([size]) => (size === 'S' ? { imageUrl: '/uploads/products/a.jpg' } : {})) })).body.data.product;

		const outside = await update(created._id, { options: [sizes], variants: every([sizes], () => ({ imageUrl: '/uploads/products/z.jpg' })) });
		const dropped = await update(created._id, { images: ['/uploads/products/c.jpg'] });

		expect(outside.status).toBe(400);
		expect(dropped.status).toBe(400);
		expect(minio.deleteFile).not.toHaveBeenCalled();
	});

	it('deletes the images nothing shows any more, after the change, and keeps one another product still shows', async () => {
		const shared = '/uploads/products/shared.jpg';
		const created = (await create({ images: ['/uploads/products/a.jpg', shared] })).body.data.product;
		await create({ images: [shared] });

		const res = await update(created._id, { images: ['/uploads/products/c.jpg'] });

		expect(res.status).toBe(200);
		expect(res.body.data.product).toMatchObject({ images: ['/uploads/products/c.jpg'], imageUrl: '/uploads/products/c.jpg' });
		expect(minio.deleteFile.mock.calls.map(([name]) => name)).toEqual(['products/a.jpg']);
	});

	it('keeps the gallery when the older form resends the same cover, and still saves when storage refuses a delete', async () => {
		const created = (await create({ images: ['/uploads/products/a.jpg', '/uploads/products/b.jpg'] })).body.data.product;

		const same = await update(created._id, { imageUrl: '/uploads/products/a.jpg', price: 11000 });
		expect(same.body.data.product.images).toEqual(['/uploads/products/a.jpg', '/uploads/products/b.jpg']);
		expect(minio.deleteFile).not.toHaveBeenCalled();

		minio.deleteFile.mockRejectedValue(new Error('storage down'));
		const replaced = await update(created._id, { images: ['/uploads/products/c.jpg'] });
		expect(replaced.status).toBe(200);
		expect(minio.deleteFile).toHaveBeenCalledTimes(2);
	});

	it('deletes every image of a deleted product', async () => {
		const created = (await create({ images: ['/uploads/products/a.jpg', '/uploads/products/b.jpg'], options: [sizes], variants: every([sizes], ([size]) => (size === 'S' ? { imageUrl: '/uploads/products/b.jpg' } : {})) })).body.data.product;

		expect((await request(app).delete(`/api/admin/products/${created._id}`).set('Cookie', cookies)).status).toBe(200);

		expect(minio.deleteFile.mock.calls.map(([name]) => name).sort()).toEqual(['products/a.jpg', 'products/b.jpg']);
	});

	it('lets two variants swap their SKUs, and archives a variant that holds stock without any movement', async () => {
		const created = (await create({ options: [sizes], variants: every([sizes], ([size]) => ({ sku: `SKU-${size}-${skuSuffix}` })) })).body.data.product;
		const swapped = await update(created._id, { options: [sizes], variants: every([sizes], ([size]) => ({ sku: `SKU-${size === 'S' ? 'M' : size === 'M' ? 'S' : 'L'}-${skuSuffix}` })) });
		expect(swapped.status).toBe(200);
		expect(byLabel(swapped.body.data.product.variants).S.sku).toBe(`SKU-M-${skuSuffix}`);

		// A balance from before the ledger: stock on the variant and its product, no movement.
		const large = byLabel(swapped.body.data.product.variants).L;
		await prisma().productVariant.update({ where: { id: large._id }, data: { stockQuantity: 4 } });
		await prisma().product.update({ where: { id: created._id }, data: { stockQuantity: { increment: 4 } } });
		const removed = await update(created._id, { options: [{ name: 'Size', values: ['S', 'M'], previousValues: ['S', 'M'] }], variants: [{ optionValues: ['S'] }, { optionValues: ['M'] }] });

		expect(removed.status).toBe(200);
		expect(byLabel(removed.body.data.product.variants).L).toMatchObject({ _id: large._id, isActive: false, stockQuantity: 4 });
	});

	it('refuses a SKU another product uses', async () => {
		const other = (await create({})).body.data.product;
		await prisma().product.update({ where: { id: other._id }, data: { sku: 'SKU-P' } });

		const res = await create({ options: [sizes], variants: every([sizes], ([size]) => (size === 'S' ? { sku: 'SKU-P' } : {})) });

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/SKU/);
		expect(await variantsOf(other._id)).toHaveLength(1);
	});
});
