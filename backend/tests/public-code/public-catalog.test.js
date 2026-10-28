const {
	findPublicProductByCode,
	findPublicComboByCode,
	toPublicProduct,
	ogVersion
} = require('../../services/public-catalog');
const { makeProduct, makeCombo } = require('../helpers/factories');
const { patchProduct, patchCombo } = require('../helpers/db');
const { products } = require('../../data');

// The record the catalog is handed in production: the repository's, variants included.
const findProduct = (id) => products.findById(id);

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

		const dto = toPublicProduct(await findProduct(product._id));

		expect(Object.keys(dto).sort()).toEqual([
			'_id', 'publicCode', 'slug', 'path', 'name', 'description', 'price', 'imageUrl', 'images', 'options', 'variants',
			'category', 'available', 'minOrderQuantity', 'maxOrderQuantity'
		].sort());
		for (const key of ['stockQuantity', 'inStock', 'sku', 'isActive', 'salePrice', 'tags', 'weight', 'dimensions']) {
			expect(dto).not.toHaveProperty(key);
		}
	});

	it('lists only the active variants and only their public fields', async () => {
		const product = await makeProduct({ price: 9000 });
		const dto = toPublicProduct({
			...(await findProduct(product._id)),
			variants: [
				{ _id: 'v1', optionValues: ['Đỏ'], label: 'Đỏ', price: 10000, effectivePrice: 10000, sku: 'SKU-R', imageUrl: '/uploads/r.jpg', isActive: true, stockQuantity: 4 },
				{ _id: 'v2', optionValues: ['Xanh'], label: 'Xanh', effectivePrice: 9000, isActive: false, archivedAt: new Date(), stockQuantity: 2 }
			]
		});

		expect(dto.variants).toEqual([{ _id: 'v1', optionValues: ['Đỏ'], label: 'Đỏ', effectivePrice: 10000, imageUrl: '/uploads/r.jpg' }]);
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

describe('ogVersion', () => {
	it('ignores stock and changes with the image', async () => {
		const product = await makeProduct({ imageUrl: '/uploads/a.jpg' });
		const before = ogVersion(toPublicProduct(await findProduct(product._id)));

		await patchProduct(product._id, { stockQuantity: 99 });
		expect(ogVersion(toPublicProduct(await findProduct(product._id)))).toBe(before);

		await patchProduct(product._id, { imageUrl: '/uploads/b.jpg' });
		const after = ogVersion(toPublicProduct(await findProduct(product._id)));
		expect(after).not.toBe(before);
		expect(after).toMatch(/^[0-9a-f]{8}$/);
	});

	it('for a combo depends on the images of its products only', async () => {
		await makeProduct({ imageUrl: '/uploads/p1.jpg' });
		const combo = await makeCombo({ salesChannel: 'online' });
		const before = ogVersion(await findPublicComboByCode(combo.publicCode));

		await patchCombo(combo._id, { price: 1 });
		expect(ogVersion(await findPublicComboByCode(combo.publicCode))).toBe(before);

		await makeProduct({ imageUrl: '/uploads/p0.jpg' });
		expect(ogVersion(await findPublicComboByCode(combo.publicCode))).not.toBe(before);
	});
});
