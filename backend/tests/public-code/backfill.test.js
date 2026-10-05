const { run } = require('../../scripts/backfill-public-codes');
const { PUBLIC_CODE_PATTERN, makeSlug } = require('../../utils/public-code');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const { makeLegacyProduct, makeLegacyCombo, makeProduct } = require('../helpers/factories');

beforeAll(() => Promise.all([Product.init(), Combo.init()]));

describe('backfill-public-codes', () => {
	it('dry run writes nothing; apply assigns codes and slugs without touching updatedAt; a re-run assigns none', async () => {
		const [a, b] = [await makeLegacyProduct({ name: 'Móc khoá' }), await makeLegacyProduct({ name: 'Mũ' })];
		const combo = await makeLegacyCombo({ name: 'Combo cũ' });
		const current = await makeProduct();

		const dry = await run({ apply: false });
		expect(dry.products).toEqual({ total: 3, missing: 2, assigned: 0 });
		expect(dry.combos).toEqual({ total: 1, missing: 1, assigned: 0 });
		expect((await Product.collection.findOne({ _id: a._id })).publicCode).toBeUndefined();

		const applied = await run({ apply: true });
		expect(applied.products).toEqual({ total: 3, missing: 2, assigned: 2 });
		expect(applied.combos).toEqual({ total: 1, missing: 1, assigned: 1 });

		const storedA = await Product.collection.findOne({ _id: a._id });
		const storedB = await Product.collection.findOne({ _id: b._id });
		const storedCombo = await Combo.collection.findOne({ _id: combo._id });
		expect(storedA.publicCode).toMatch(PUBLIC_CODE_PATTERN);
		expect(storedA.slug).toBe(makeSlug('Móc khoá', storedA.publicCode));
		expect(storedB.publicCode).not.toBe(storedA.publicCode);
		expect(storedCombo.publicCode).toMatch(PUBLIC_CODE_PATTERN);
		expect(storedA.updatedAt).toEqual(a.updatedAt);
		expect((await Product.findById(current._id).lean()).publicCode).toBe(current.publicCode);

		const again = await run({ apply: true });
		expect(again.products).toEqual({ total: 3, missing: 0, assigned: 0 });
		expect(again.combos).toEqual({ total: 1, missing: 0, assigned: 0 });
	});
});
