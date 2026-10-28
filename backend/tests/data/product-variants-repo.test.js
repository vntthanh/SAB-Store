/**
 * Images, options and variants as the product repository and the stock ledger
 * see them on Postgres: what each read returns, who may see stock, and that a
 * movement moves its variant and its product together. Options and variants are
 * seeded with the Prisma client, never through the repository under test.
 */
const { v7: uuidv7 } = require('uuid');
const data = require('../../data');
const { recordMovement, applyMovement } = require('../../services/stock-ledger');
const { insertRawProduct, findProduct, deleteProduct } = require('../helpers/db');
const { POSTGRES } = require('../helpers/backend');
const { generatePublicCode } = require('../../utils/public-code');

const { products } = data;

const prisma = () => require('../../lib/prisma').prisma;

/** A product with option `Size` (S, M) and its two variants; the default variant the raw insert made is removed. */
async function sizedProduct({ price = 10000, stockQuantity = 0 } = {}) {
	const product = await insertRawProduct({ price, stockQuantity, name: `Áo ${uuidv7()}`, publicCode: generatePublicCode(), withDefaultVariant: false });
	await prisma().productOption.create({ data: { productId: product._id, position: 0, name: 'Size', values: ['S', 'M'] } });
	const small = await prisma().productVariant.create({ data: { productId: product._id, position: 0, optionValues: ['S'], sku: `S-${product._id}`, stockQuantity } });
	const medium = await prisma().productVariant.create({ data: { productId: product._id, position: 1, optionValues: ['M'], price: 12000 } });
	return { product, small, medium };
}

const variantStock = async (id) => (await prisma().productVariant.findUnique({ where: { id } })).stockQuantity;

describe.skipIf(!POSTGRES)('product records: images, options and variants', () => {
	it('gives a new product its default variant holding the opening stock, and keeps the cover as the gallery', async () => {
		const created = await data.withTransaction((tx) => products.create({ name: 'Mũ', price: 5000, category: 'c', imageUrl: '/uploads/a.jpg' }, 4, tx));

		expect(created.images).toEqual(['/uploads/a.jpg']);
		expect(created.options).toEqual([]);
		expect(created.variants).toEqual([{ _id: expect.any(String), optionValues: [], effectivePrice: 5000, isActive: true, stockQuantity: 4 }]);

		const updated = await products.update(created._id, { imageUrl: '/uploads/b.jpg' });
		expect(updated.images).toEqual(['/uploads/b.jpg']);
		expect((await products.update(created._id, { imageUrl: '' })).images).toEqual([]);
		expect((await findProduct(created._id)).imageUrl).toBe('/fallback-product.png');
	});

	it('lists options in position order and variants with their label and effective price for an admin', async () => {
		const { product, small, medium } = await sizedProduct({ stockQuantity: 3 });

		const found = await products.findById(product._id);

		expect(found.options).toEqual([{ name: 'Size', values: ['S', 'M'] }]);
		expect(found.variants).toEqual([
			{ _id: small.id, optionValues: ['S'], label: 'S', effectivePrice: 10000, sku: small.sku, isActive: true, stockQuantity: 3 },
			{ _id: medium.id, optionValues: ['M'], label: 'M', price: 12000, effectivePrice: 12000, isActive: true, stockQuantity: 0 }
		]);
	});

	it('shows customers only the active variants, never their stock or SKU', async () => {
		const { product, small, medium } = await sizedProduct({ stockQuantity: 3 });
		await prisma().productVariant.update({ where: { id: medium.id }, data: { isActive: false, archivedAt: new Date() } });

		const [listed] = (await products.listSellable('online', { forCustomers: true })).filter((row) => row._id === product._id);

		expect(listed.variants).toEqual([{ _id: small.id, optionValues: ['S'], label: 'S', effectivePrice: 10000 }]);
		expect(listed).not.toHaveProperty('stockQuantity');
	});

	it('loads variants for pricing only when asked', async () => {
		const { product, small } = await sizedProduct();

		const [plain] = await products.findSellableForPricing('online', [product._id], ['name', 'price']);
		const [priced] = await products.findSellableForPricing('online', [product._id], ['name', 'price', 'variants']);

		expect(plain).not.toHaveProperty('variants');
		expect(priced.variants[0]).toMatchObject({ _id: small.id, effectivePrice: 10000 });
	});
});

describe.skipIf(!POSTGRES)('stock movements per variant', () => {
	const movement = (fields) => recordMovement({ type: 'adjust', delta: 2, idempotencyKey: `k-${uuidv7()}`, createdBy: 'admin', reason: 'r', ...fields });

	it('moves the named variant and its product by the same delta', async () => {
		const { product, small, medium } = await sizedProduct({ stockQuantity: 3 });

		await applyMovement((await movement({ productId: product._id, variantId: medium.id, delta: 5 }))._id);

		expect(await variantStock(medium.id)).toBe(5);
		expect(await variantStock(small.id)).toBe(3);
		expect((await findProduct(product._id)).stockQuantity).toBe(8);
	});

	it('puts a movement that names no variant on the default variant', async () => {
		const product = await insertRawProduct({ stockQuantity: 1 });
		const [defaultVariant] = (await products.findById(product._id)).variants;

		const recorded = await movement({ productId: product._id });
		await applyMovement(recorded._id);

		expect(recorded.variantId).toBe(defaultVariant._id);
		expect(await variantStock(defaultVariant._id)).toBe(3);
		expect((await findProduct(product._id)).stockQuantity).toBe(3);
	});

	it('refuses a movement without a variant for a product that has options', async () => {
		const { product } = await sizedProduct();

		await expect(movement({ productId: product._id })).rejects.toThrow(/must name its variant/);
	});

	it('settles a movement of a deleted product instead of blocking the queue', async () => {
		const product = await insertRawProduct({});
		await deleteProduct(product._id);

		const recorded = await movement({ productId: product._id });

		expect((await applyMovement(recorded._id)).applied).toBe(true);
		expect(await prisma().stockMovement.findUnique({ where: { id: recorded._id } })).toMatchObject({ status: 'applied', lastError: 'PRODUCT_NOT_FOUND' });
	});

	it('sets one variant to a target from that variant\'s own stock, moving the product by the same delta', async () => {
		const { product, small, medium } = await sizedProduct({ stockQuantity: 3 });
		await applyMovement((await movement({ productId: product._id, variantId: medium.id, delta: 7 }))._id);

		const recorded = await recordMovement({ productId: product._id, variantId: small.id, type: 'set_target', target: 5, idempotencyKey: `t-${uuidv7()}`, createdBy: 'admin', reason: 'r' });
		await applyMovement(recorded._id);

		expect(await variantStock(small.id)).toBe(5);
		expect(await variantStock(medium.id)).toBe(7);
		expect((await findProduct(product._id)).stockQuantity).toBe(12);
		expect(await prisma().stockMovement.findUnique({ where: { id: recorded._id } })).toMatchObject({ delta: 2, stockAfter: 5 });
	});

	it('settles a movement whose variant belongs to another product as VARIANT_NOT_FOUND, moving nothing', async () => {
		const { product, small } = await sizedProduct({ stockQuantity: 3 });
		const other = await insertRawProduct({});

		const recorded = await movement({ productId: other._id, variantId: small.id });
		await applyMovement(recorded._id);

		const stored = await prisma().stockMovement.findUnique({ where: { id: recorded._id } });
		expect(stored).toMatchObject({ status: 'applied', lastError: 'VARIANT_NOT_FOUND' });
		expect(await variantStock(small.id)).toBe(3);
		expect((await findProduct(product._id)).stockQuantity).toBe(3);
	});
});

describe.skipIf(!POSTGRES)('snapshot of variants', () => {
	const { validateSnapshot, buildMetadata } = require('../../data/snapshot');
	const { reconcile } = require('../../services/stock-ledger');

	it('restores options, variants and images to the same rows, ids kept', async () => {
		const { product, small, medium } = await sizedProduct();
		await prisma().product.update({ where: { id: product._id }, data: { images: ['/uploads/a.jpg', '/uploads/b.jpg'], imageUrl: '/uploads/a.jpg' } });
		await prisma().productVariant.update({ where: { id: medium.id }, data: { imageUrl: '/uploads/b.jpg', isActive: false, archivedAt: new Date('2026-10-01T00:00:00Z') } });
		const before = await data.dataSnapshot.exportAll();
		expect(validateSnapshot(buildMetadata(before, new Date()), before)).toEqual([]);

		await data.withTransaction((tx) => data.dataSnapshot.replaceAll(before, tx));

		const after = await data.dataSnapshot.exportAll();
		expect(after.products).toEqual(before.products);
		const restored = after.products.find((row) => row._id === product._id);
		expect(restored.variants.map((variant) => variant._id)).toEqual([small.id, medium.id]);
		expect(restored.images).toEqual(['/uploads/a.jpg', '/uploads/b.jpg']);
		expect(await reconcile()).toEqual([]);
	});

	it('restores a file from before variants with a default variant per product, its lines and movements pointed at it', async () => {
		const product = await data.withTransaction(async (tx) => {
			const created = await products.create({ name: 'Cũ', price: 1000, category: 'c', imageUrl: '/uploads/old.jpg' }, 4, tx);
			await require('../../services/stock-ledger').recordAppliedOpening({ productId: created._id, quantity: 4, createdBy: 'a', reason: 'r' }, { tx });
			return created;
		});
		const exported = await data.dataSnapshot.exportAll();
		const legacy = {
			...exported,
			products: exported.products.map(({ images: _i, options: _o, variants: _v, ...row }) => row),
			stockMovements: exported.stockMovements.map(({ variantId: _v, ...row }) => row),
			orders: [{
				_id: uuidv7(), orderCode: 'LEG01', totalAmount: 1000, status: 'confirmed',
				items: [{ productId: product._id, productName: 'Cũ', price: 1000, quantity: 1 }]
			}]
		};
		expect(validateSnapshot(buildMetadata(legacy, new Date()), legacy)).toEqual([]);

		await data.withTransaction((tx) => data.dataSnapshot.replaceAll(legacy, tx));

		const restored = await products.findById(product._id);
		expect(restored.images).toEqual(['/uploads/old.jpg']);
		expect(restored.variants).toEqual([expect.objectContaining({ optionValues: [], stockQuantity: 4 })]);
		const defaultId = restored.variants[0]._id;
		expect(defaultId).not.toBe(product.variants[0]._id);
		const after = await data.dataSnapshot.exportAll();
		expect(after.orders[0].items[0].variantId).toBe(defaultId);
		expect(after.stockMovements.map((row) => row.variantId)).toEqual([defaultId]);
		expect(await reconcile()).toEqual([]);
	});

	it('refuses a movement without a variant, a cover that is not the first image, and ten images', async () => {
		const { product } = await sizedProduct();
		const snapshot = await data.dataSnapshot.exportAll();
		const withProduct = (change) => ({ ...snapshot, products: snapshot.products.map((row) => (row._id === product._id ? { ...row, ...change } : row)) });
		const problemsOf = (file) => validateSnapshot(buildMetadata(file, new Date()), file).join('\n');

		const unnamed = { ...snapshot, stockMovements: [{ _id: uuidv7(), productId: product._id, type: 'adjust', delta: 50, idempotencyKey: 'x', status: 'pending' }] };
		expect(problemsOf(unnamed)).toMatch(/thiếu "variantId"/);
		expect(problemsOf(withProduct({ imageUrl: '/uploads/b.jpg', images: ['/uploads/a.jpg'] }))).toMatch(/ảnh đầu tiên/);
		const ten = Array.from({ length: 10 }, (_, i) => `/uploads/${i}.jpg`);
		expect(problemsOf(withProduct({ imageUrl: ten[0], images: ten }))).toMatch(/tối đa 9 ảnh/);
	});

	it('refuses a file whose line names a variant of another product, or mixes products with and without variants', async () => {
		const { product } = await sizedProduct();
		const other = await insertRawProduct({ publicCode: generatePublicCode() });
		const snapshot = await data.dataSnapshot.exportAll();
		const otherVariant = snapshot.products.find((row) => row._id === other._id).variants[0]._id;
		const stray = { ...snapshot, stockMovements: [{ _id: uuidv7(), productId: product._id, variantId: otherVariant, type: 'adjust', delta: 1, idempotencyKey: 'x', status: 'applied' }] };
		expect(validateSnapshot(buildMetadata(stray, new Date()), stray).join('\n')).toMatch(/không phải phân loại của sản phẩm/);

		const mixed = { ...snapshot, products: snapshot.products.map((row) => (row._id === other._id ? { ...row, variants: undefined, options: undefined, images: undefined } : row)) };
		expect(validateSnapshot(buildMetadata(mixed, new Date()), mixed).join('\n')).toMatch(/cùng có hoặc cùng không có/);
	});
});
