const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const {
	findPublicProductByCode,
	findPublicComboByCode,
	toPublicProduct,
	ogVersion
} = require('../../services/public-catalog');
const { makeProduct, makeCombo } = require('../helpers/factories');

beforeAll(() => Promise.all([Product.init(), Combo.init()]));

describe('findPublicProductByCode', () => {
	it('returns a product sellable online, found by a case- and space-insensitive code', async () => {
		const product = await makeProduct({ salesChannel: 'online' });

		const found = await findPublicProductByCode(` ${product.publicCode.toLowerCase()} `);

		expect(found._id.toString()).toBe(product._id.toString());
		expect(found.path).toBe(`/p/${product.publicCode}/${product.slug}`);
	});

	it('returns null for offline-only, unavailable, unknown and malformed codes', async () => {
		const offline = await makeProduct({ salesChannel: 'offline' });
		const hidden = await makeProduct({ available: false });

		expect(await findPublicProductByCode(offline.publicCode)).toBeNull();
		expect(await findPublicProductByCode(hidden.publicCode)).toBeNull();
		expect(await findPublicProductByCode('ZZZZZZZZ')).toBeNull();
		expect(await findPublicProductByCode({ $ne: null })).toBeNull();
	});
});

describe('toPublicProduct', () => {
	it('exposes exactly the allow-listed keys and no stock, sku or sale data', async () => {
		const product = await makeProduct({
			sku: 'SKU-1', salePrice: 10, tags: ['a'], weight: 3, dimensions: { length: 1 }, stockQuantity: 7
		});

		const dto = toPublicProduct(await Product.findById(product._id));

		expect(Object.keys(dto).sort()).toEqual([
			'_id', 'publicCode', 'slug', 'path', 'name', 'description', 'price', 'imageUrl',
			'category', 'available', 'minOrderQuantity', 'maxOrderQuantity'
		].sort());
		for (const key of ['stockQuantity', 'inStock', 'sku', 'isActive', 'salePrice', 'tags', 'weight', 'dimensions']) {
			expect(dto).not.toHaveProperty(key);
		}
	});
});

describe('findPublicComboByCode', () => {
	it('merges requirements of the same category and lists every eligible online product by name', async () => {
		const products = [];
		for (let i = 0; i < 15; i++) products.push(await makeProduct({ salesChannel: i % 2 ? 'online' : 'all' }));
		await makeProduct({ salesChannel: 'offline' });
		await makeProduct({ available: false });
		await makeProduct({ category: 'other' });
		const combo = await makeCombo({
			salesChannel: 'online',
			categoryRequirements: [{ category: 'general', quantity: 1 }, { category: 'general', quantity: 2 }]
		});

		const dto = await findPublicComboByCode(combo.publicCode);

		expect(dto.requirements).toHaveLength(1);
		expect(dto.requirements[0]).toMatchObject({ category: 'general', quantity: 3 });
		const names = dto.requirements[0].products.map((p) => p.name);
		expect(names).toHaveLength(15);
		expect(names).toEqual([...names].sort());
		expect(dto.path).toBe(`/c/${combo.publicCode}/${combo.slug}`);
	});

	it('still returns the combo, with empty product lists, when no online product matches', async () => {
		const combo = await makeCombo({ salesChannel: 'online', categoryRequirements: [{ category: 'ghost', quantity: 1 }] });

		const dto = await findPublicComboByCode(combo.publicCode);

		expect(dto).not.toBeNull();
		expect(dto.requirements).toEqual([{ category: 'ghost', quantity: 1, products: [] }]);
	});

	it('returns null for an offline-only or inactive combo', async () => {
		const offline = await makeCombo({ salesChannel: 'offline' });
		const inactive = await makeCombo({ isActive: false });

		expect(await findPublicComboByCode(offline.publicCode)).toBeNull();
		expect(await findPublicComboByCode(inactive.publicCode)).toBeNull();
	});
});

describe('Combo.findSellable', () => {
	it('works without a filter and with one, and drops combos of the other channel', async () => {
		const online = await makeCombo({ salesChannel: 'online' });
		const offline = await makeCombo({ salesChannel: 'offline' });

		const all = await Combo.findSellable('online');
		expect(all.map((c) => c._id.toString())).toEqual([online._id.toString()]);

		const filtered = await Combo.findSellable('online', { publicCode: online.publicCode });
		expect(filtered).toHaveLength(1);
		expect(await Combo.findSellable('online', { publicCode: offline.publicCode })).toHaveLength(0);
	});
});

describe('ogVersion', () => {
	it('ignores stock and changes with the image', async () => {
		const product = await makeProduct({ imageUrl: '/uploads/a.jpg' });
		const before = ogVersion(toPublicProduct(await Product.findById(product._id)));

		await Product.updateOne({ _id: product._id }, { $set: { stockQuantity: 99 } });
		expect(ogVersion(toPublicProduct(await Product.findById(product._id)))).toBe(before);

		await Product.updateOne({ _id: product._id }, { $set: { imageUrl: '/uploads/b.jpg' } });
		const after = ogVersion(toPublicProduct(await Product.findById(product._id)));
		expect(after).not.toBe(before);
		expect(after).toMatch(/^[0-9a-f]{8}$/);
	});

	it('for a combo depends on the images of its products only', async () => {
		await makeProduct({ imageUrl: '/uploads/p1.jpg' });
		const combo = await makeCombo({ salesChannel: 'online' });
		const before = ogVersion(await findPublicComboByCode(combo.publicCode));

		await Combo.updateOne({ _id: combo._id }, { $set: { price: 1 } });
		expect(ogVersion(await findPublicComboByCode(combo.publicCode))).toBe(before);

		await makeProduct({ imageUrl: '/uploads/p0.jpg' });
		expect(ogVersion(await findPublicComboByCode(combo.publicCode))).not.toBe(before);
	});
});
