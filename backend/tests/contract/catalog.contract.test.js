/**
 * The product and combo repositories. Rows are written and re-read through
 * tests/helpers/db.js, so a backend that returns the right records but stores
 * the wrong rows fails here.
 */
const data = require('../../data');
const publicCodeUtil = require('../../utils/public-code');
const { DuplicateKeyError, InvalidIdError, RecordValidationError, isDuplicateKeyOn } = require('../../data/errors');
const { recordAppliedOpening } = require('../../services/stock-ledger');
const { computeOrderPricing } = require('../../services/pricing');
const { normalizeRecordId } = require('../../data/ids');
const {
	newId, findProduct, findCombo, countRows, insertRawProduct, insertRawCombo, stockOf, movements,
	withTransaction, txOptions, isRowId,
} = require('../helpers/db');

const { products, combos } = data;

afterAll(async () => {
	await require('../../lib/prisma').closeDb();
});

let sequence = 0;
const unique = (label) => `${label} ${++sequence}`;
const at = (minutes) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
const names = (records) => records.map((record) => record.name);

/** A product row the way an older version stored it: only what the test names, no schema defaults. */
const rawProduct = (fields = {}) => insertRawProduct({ name: unique('Product'), price: 1000, category: 'general', available: true, ...fields });
const rawCombo = (fields = {}) => insertRawCombo({
	name: unique('Combo'), price: 5000, isActive: true, categoryRequirements: [{ category: 'general', quantity: 1 }], ...fields,
});

const VALID_PRODUCT = { name: 'Bút', price: 1000, category: 'general' };
const VALID_COMBO = { name: 'Bộ đôi', price: 5000, categoryRequirements: [{ category: 'a', quantity: 2 }, { category: 'b', quantity: 1 }] };

const failure = (promise) => promise.then(() => { throw new Error('expected the call to reject'); }, (error) => error);
const fieldsOf = (error) => error.fieldErrors.map((entry) => entry.field);
/** The keys of a record, sorted, without a storage version key callers must not read. */
const withoutVersion = (record) => Object.keys(record).filter((key) => key !== '__v').sort();

describe('sellable products per channel', () => {
	it('offers a product on the channels its salesChannel allows, only while available', async () => {
		await rawProduct({ name: 'for all', salesChannel: 'all' });
		await rawProduct({ name: 'only online', salesChannel: 'online' });
		await rawProduct({ name: 'only offline', salesChannel: 'offline' });
		await rawProduct({ name: 'switched off', salesChannel: 'all', available: false });
		await rawProduct({ name: 'switched off online', salesChannel: 'online', available: false });

		expect(names(await products.findSellable('online')).sort()).toEqual(['for all', 'only online']);
		expect(names(await products.findSellable('offline')).sort()).toEqual(['for all', 'only offline']);
		expect(names(await products.listSellable('online')).sort()).toEqual(['for all', 'only online']);
		expect(names(await products.listSellable('offline')).sort()).toEqual(['for all', 'only offline']);
	});

	it('treats a row stored without a salesChannel as sellable on every channel', async () => {
		await rawProduct({ name: 'legacy row' });

		expect(names(await products.findSellable('online'))).toEqual(['legacy row']);
		expect(names(await products.findSellable('offline'))).toEqual(['legacy row']);
	});

	it('narrows by publicCode and by id', async () => {
		const wanted = await rawProduct({ name: 'wanted', publicCode: 'WWWWWWWW' });
		await rawProduct({ name: 'other', publicCode: 'XXXXXXXX' });

		expect(names(await products.findSellable('online', { publicCode: 'WWWWWWWW' }))).toEqual(['wanted']);
		expect(names(await products.findSellable('online', { id: wanted._id }))).toEqual(['wanted']);
		expect(await products.findSellable('online', { publicCode: 'NNNNNNNN' })).toEqual([]);
	});

	it('refuses a missing or unknown channel on the call itself', async () => {
		expect(() => products.findSellable(undefined)).toThrow(TypeError);
		expect(() => products.findSellable('all')).toThrow(TypeError);
		await expect(products.listSellable('nowhere')).rejects.toThrow(TypeError);
		expect(() => combos.findSellable('nowhere')).toThrow(TypeError);
	});

	it('loads only the named fields for pricing, with ids in the store\'s own form', async () => {
		const online = await rawProduct({ name: 'priced', salesChannel: 'online', stockQuantity: 9, sku: 'SKU-1', maxOrderQuantity: null });
		const offline = await rawProduct({ name: 'wrong channel', salesChannel: 'offline' });

		const found = await products.findSellableForPricing('online', [online._id, offline._id], ['_id', 'name', 'price', 'maxOrderQuantity']);

		expect(found).toHaveLength(1);
		expect(isRowId(found[0]._id)).toBe(true);
		expect(String(found[0]._id)).toBe(online._id);
		expect(Object.keys(found[0]).sort()).toEqual(['_id', 'maxOrderQuantity', 'name', 'price']);
		expect(found[0]).toMatchObject({ name: 'priced', price: 1000 });
	});

	it('names the available products that are not sellable on the channel', async () => {
		const offline = await rawProduct({ name: 'offline only', salesChannel: 'offline' });
		const off = await rawProduct({ name: 'off', available: false });

		expect(await products.findAvailableNames([offline._id, off._id])).toEqual(['offline only']);
	});

	it('lists sellable products of the given categories by name', async () => {
		await rawProduct({ name: 'b pen', category: 'pens' });
		await rawProduct({ name: 'a pen', category: 'pens' });
		await rawProduct({ name: 'a cup', category: 'cups' });
		await rawProduct({ name: 'a bag', category: 'bags' });
		await rawProduct({ name: 'hidden pen', category: 'pens', salesChannel: 'offline' });

		const found = await products.listSellableInCategories('online', ['pens', 'cups'], ['name', 'category']);

		expect(names(found)).toEqual(['a cup', 'a pen', 'b pen']);
	});

	it('hides stock, sku and isActive from customers and keeps them for staff', async () => {
		await rawProduct({ name: 'listed', stockQuantity: 4, sku: 'SKU-2', isActive: true });

		const [staff] = await products.listSellable('online');
		const [customer] = await products.listSellable('online', { forCustomers: true });

		expect(staff).toMatchObject({ stockQuantity: 4, sku: 'SKU-2', isActive: true });
		for (const hidden of ['stockQuantity', 'sku', 'isActive']) expect(customer).not.toHaveProperty(hidden);
		expect(customer.name).toBe('listed');
	});

	it('returns findSellable oldest first whatever order the rows were written in', async () => {
		await rawProduct({ name: 'second', createdAt: at(2) });
		await rawProduct({ name: 'third', createdAt: at(3) });
		await rawProduct({ name: 'first', createdAt: at(1) });

		expect(names(await products.findSellable('online'))).toEqual(['first', 'second', 'third']);
	});

	it('orders the customer list by category, then name', async () => {
		await rawProduct({ name: 'b', category: 'y' });
		await rawProduct({ name: 'a', category: 'y' });
		await rawProduct({ name: 'z', category: 'x' });

		expect(names(await products.listSellable('online'))).toEqual(['z', 'a', 'b']);
	});
});

// The databases use the builtin C.UTF-8 collation, which is code point order.
// A different collation would reorder the storefront without any test noticing.
describe('code point sort order', () => {
	const MIXED = ['Z', 'a', 'Áo', 'ao', 'Đ', 'B'];
	const CODE_POINT_ORDER = ['B', 'Z', 'a', 'ao', 'Áo', 'Đ'];

	it('sorts the customer list by category, then name, in code point order', async () => {
		for (const name of MIXED) await rawProduct({ name, category: 'same' });
		await rawProduct({ name: 'first', category: 'Zeta' });
		await rawProduct({ name: 'second', category: 'alpha' });
		await rawProduct({ name: 'third', category: 'Đồ' });

		const listed = await products.listSellable('online');

		expect(names(listed.filter((record) => record.category === 'same'))).toEqual(CODE_POINT_ORDER);
		expect(listed.map((record) => record.category).filter((category, i, all) => all.indexOf(category) === i))
			.toEqual(['Zeta', 'alpha', 'same', 'Đồ'].sort());
	});

	it('sorts the category lookup by name in code point order', async () => {
		for (const name of MIXED) await rawProduct({ name, category: 'same' });

		expect(names(await products.listSellableInCategories('online', ['same'], ['name']))).toEqual(CODE_POINT_ORDER);
	});
});

describe('sellable combos per channel', () => {
	it('offers an active combo on the channels it allows', async () => {
		await rawCombo({ name: 'for all', salesChannel: 'all' });
		await rawCombo({ name: 'only online', salesChannel: 'online' });
		await rawCombo({ name: 'only offline', salesChannel: 'offline' });
		await rawCombo({ name: 'stopped', salesChannel: 'all', isActive: false });
		await rawCombo({ name: 'legacy row' });

		expect(names(await combos.findSellable('online')).sort()).toEqual(['for all', 'legacy row', 'only online']);
		expect(names(await combos.findSellable('offline')).sort()).toEqual(['for all', 'legacy row', 'only offline']);
		expect(names(await combos.listSellable('offline')).sort()).toEqual(['for all', 'legacy row', 'only offline']);
	});

	it('offers combos highest priority first, then newest', async () => {
		await rawCombo({ name: 'low', priority: 1, createdAt: at(1) });
		await rawCombo({ name: 'high old', priority: 5, createdAt: at(2) });
		await rawCombo({ name: 'high new', priority: 5, createdAt: at(3) });

		expect(names(await combos.findSellable('online'))).toEqual(['high new', 'high old', 'low']);
		expect(names(await combos.list())).toEqual(['high new', 'high old', 'low']);
		expect(names(await combos.list({ active: true }))).toEqual(['high new', 'high old', 'low']);
		expect(await combos.list({ active: false })).toEqual([]);
	});

	it('loads the named fields for pricing, requirements in order with their own ids', async () => {
		const combo = await rawCombo({
			name: 'priced', priority: 2, categoryRequirements: [{ category: 'a', quantity: 2 }, { category: 'b', quantity: 1 }],
		});

		const [found] = await combos.findSellableForPricing('online', ['_id', 'name', 'price', 'categoryRequirements', 'priority']);

		expect(isRowId(found._id)).toBe(true);
		expect(String(found._id)).toBe(combo._id);
		expect(Object.keys(found).sort()).toEqual(['_id', 'categoryRequirements', 'name', 'price', 'priority']);
		expect(found.categoryRequirements.map(({ category, quantity }) => [category, quantity])).toEqual([['a', 2], ['b', 1]]);
	});

	it('narrows by publicCode', async () => {
		await rawCombo({ name: 'wanted', publicCode: 'WWWWWWWW' });
		await rawCombo({ name: 'other', publicCode: 'XXXXXXXX' });

		expect(names(await combos.findSellable('online', { publicCode: 'WWWWWWWW' }))).toEqual(['wanted']);
	});
});

describe('public code and slug', () => {
	const takeCodes = (...codes) => {
		const draw = vi.spyOn(publicCodeUtil, 'generatePublicCode');
		for (const code of codes) draw.mockReturnValueOnce(code);
		return draw;
	};

	it('draws a code and a slug for a new product and combo', async () => {
		const product = await products.create({ ...VALID_PRODUCT, name: 'Áo thun SAB' }, 0, null);
		const combo = await combos.create(VALID_COMBO);

		expect(product.publicCode).toMatch(publicCodeUtil.PUBLIC_CODE_PATTERN);
		expect(product.slug).toBe('ao-thun-sab');
		expect(combo.publicCode).toMatch(publicCodeUtil.PUBLIC_CODE_PATTERN);
		expect(combo.slug).toBe('bo-doi');
	});

	it('keeps a code the caller supplies (a restore)', async () => {
		const product = await products.create({ ...VALID_PRODUCT, publicCode: 'CCCCCCCC' }, 0, null);
		const combo = await combos.create({ ...VALID_COMBO, publicCode: 'DDDDDDDD' });

		expect([product.publicCode, combo.publicCode]).toEqual(['CCCCCCCC', 'DDDDDDDD']);
	});

	it('rejects a drawn product code that is taken, naming the column, so the caller can reroll', async () => {
		await rawProduct({ publicCode: 'AAAAAAAA' });
		takeCodes('AAAAAAAA');

		const error = await failure(products.create(VALID_PRODUCT, 0, null));

		expect(error).toBeInstanceOf(DuplicateKeyError);
		expect(error.fields).toEqual(['publicCode']);
		expect(isDuplicateKeyOn(error, 'publicCode')).toBe(true);
	});

	it('rolls the whole transaction back and draws again when the caller wraps the create in the retry', async () => {
		await rawProduct({ publicCode: 'AAAAAAAA' });
		const draw = takeCodes('AAAAAAAA', 'BBBBBBBB');

		const created = await publicCodeUtil.withPublicCodeRetry(() => data.withTransaction(async (tx) => {
			const product = await products.create(VALID_PRODUCT, 3, tx);
			await recordAppliedOpening({ productId: product._id, quantity: 3 }, txOptions(tx));
			return product;
		}));

		expect(draw).toHaveBeenCalledTimes(2);
		expect(created.publicCode).toBe('BBBBBBBB');
		expect(await countRows('product')).toBe(2);
		expect(await movements({ productId: created._id })).toHaveLength(1);
		expect(await countRows('movement')).toBe(1);
	});

	it('draws again by itself when a combo code is taken', async () => {
		await rawCombo({ publicCode: 'AAAAAAAA' });
		const draw = takeCodes('AAAAAAAA', 'BBBBBBBB');

		const combo = await combos.create(VALID_COMBO);

		expect(draw).toHaveBeenCalledTimes(2);
		expect(combo.publicCode).toBe('BBBBBBBB');
		expect(await countRows('combo')).toBe(2);
	});

	it('tries a supplied combo code once and reports the collision', async () => {
		await rawCombo({ publicCode: 'AAAAAAAA' });
		const draw = takeCodes('BBBBBBBB');

		const error = await failure(combos.create({ ...VALID_COMBO, publicCode: 'AAAAAAAA' }));

		expect(error).toBeInstanceOf(DuplicateKeyError);
		expect(draw).not.toHaveBeenCalled();
		expect(await countRows('combo')).toBe(1);
	});

	it('refuses a supplied code that is not in the code format', async () => {
		const error = await failure(products.create({ ...VALID_PRODUCT, publicCode: 'lower-case' }, 0, null));

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(fieldsOf(error)).toContain('publicCode');
	});

	it('refuses a supplied code that is not in the code format, for a product and a combo', async () => {
		const productError = await failure(products.create({ ...VALID_PRODUCT, publicCode: 'nope' }, 0, null));
		const comboError = await failure(combos.create({ ...VALID_COMBO, publicCode: 'nope' }));

		for (const error of [productError, comboError]) {
			expect(error).toBeInstanceOf(RecordValidationError);
			expect(fieldsOf(error)).toContain('publicCode');
		}
		expect(await countRows('product')).toBe(0);
		expect(await countRows('combo')).toBe(0);
	});

	it('makes the slug follow a rename and keeps it through other edits', async () => {
		const product = await products.create({ ...VALID_PRODUCT, name: 'Áo thun' }, 0, null);
		const combo = await combos.create({ ...VALID_COMBO, name: 'Bộ đôi' });

		const renamedProduct = await products.update(product._id, { name: '  Mũ SAB  ' });
		const renamedCombo = await combos.update(combo._id, { name: 'Bộ ba' });
		const repriced = await products.update(product._id, { price: 2000 });
		const repricedCombo = await combos.update(combo._id, { price: 6000 });

		expect([renamedProduct.slug, renamedCombo.slug]).toEqual(['mu-sab', 'bo-ba']);
		expect([repriced.slug, repricedCombo.slug]).toEqual(['mu-sab', 'bo-ba']);
		expect((await findProduct(product._id)).slug).toBe('mu-sab');
		expect((await findCombo(combo._id)).slug).toBe('bo-ba');
		expect([renamedProduct.publicCode, renamedCombo.publicCode]).toEqual([product.publicCode, combo.publicCode]);
	});

	it('never writes publicCode or slug from an update', async () => {
		const product = await products.create(VALID_PRODUCT, 0, null);
		const combo = await combos.create(VALID_COMBO);

		await products.update(product._id, { price: 1, publicCode: 'ZZZZZZZZ', slug: 'hacked' });
		await combos.update(combo._id, { price: 1, publicCode: 'ZZZZZZZZ', slug: 'hacked' });

		const storedProduct = await findProduct(product._id);
		const storedCombo = await findCombo(combo._id);
		expect([storedProduct.publicCode, storedProduct.slug]).toEqual([product.publicCode, product.slug]);
		expect([storedCombo.publicCode, storedCombo.slug]).toEqual([combo.publicCode, combo.slug]);
	});
});

describe('search escaping', () => {
	const NAMES = ['50% off', '50_off', '50 off', 'a.b', 'axb', 'a*b', 'back\\slash', 'Ordinary Item'];

	beforeEach(async () => {
		for (const name of NAMES) await rawProduct({ name });
		await rawProduct({ name: 'plain', description: 'Has a Hidden Phrase inside' });
	});

	const searchPage = async (search) => names((await products.listPage({ page: 1, limit: 50, search })).data).sort();
	const searchSellable = async (search) => names(await products.listSellable('online', { search })).sort();

	it.each([
		['%', ['50% off']],
		['_', ['50_off']],
		['.', ['a.b']],
		['*', ['a*b']],
		['.*', []],
		['a.b', ['a.b']],
		['\\', ['back\\slash']],
		['% off', ['50% off']],
		['%off', []],
		['a_b', []],
		['ORDINARY item', ['Ordinary Item']],
		['hidden phrase', ['plain']],
	])('matches %j literally and ignoring case', async (search, expected) => {
		expect(await searchPage(search)).toEqual(expected);
		expect(await searchSellable(search)).toEqual(expected);
	});

	it('applies no filter for an empty or non-text search', async () => {
		const all = [...NAMES, 'plain'].sort();

		expect(await searchPage('')).toEqual(all);
		expect(await searchPage(undefined)).toEqual(all);
		expect(await searchPage({ $ne: null })).toEqual(all);
		expect(await searchPage(['a'])).toEqual(all);
	});

	it('keeps the search terms to their first 100 characters', async () => {
		await rawProduct({ name: 'a'.repeat(100) });

		expect(await searchPage('a'.repeat(150))).toEqual(['a'.repeat(100)]);
	});
});

describe('what Prisma does with the characters of a LIKE pattern (postgres)', () => {
	it('does not escape them in contains, which is why every search goes through escapeLike', async () => {
		const { prisma } = require('../../lib/prisma');
		await rawProduct({ name: '50% off' });
		await rawProduct({ name: 'plain' });

		const raw = await prisma.product.findMany({ where: { name: { contains: '%', mode: 'insensitive' } } });
		const escaped = await prisma.product.findMany({ where: { name: require('../../data/postgres/like').containsInsensitive('%') } });

		expect(raw.map((row) => row.name).sort()).toEqual(['50% off', 'plain']);
		expect(escaped.map((row) => row.name)).toEqual(['50% off']);
	});
});

describe('product page', () => {
	it('returns the envelope with a count of every match, not of the page', async () => {
		for (let i = 0; i < 5; i += 1) await rawProduct({ name: `item ${i}`, createdAt: at(i) });

		const page = await products.listPage({ page: 2, limit: 2 });

		expect(page.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
		expect(names(page.data)).toEqual(['item 2', 'item 1']);
	});

	it('reports zero pages for no match', async () => {
		const page = await products.listPage({ page: 1, limit: 10, category: 'nothing here' });

		expect(page).toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } });
	});

	it('walks equal-createdAt rows page by page without repeating or dropping one', async () => {
		const created = [];
		for (let i = 0; i < 7; i += 1) created.push((await rawProduct({ createdAt: at(10) }))._id);

		const walked = [];
		for (let page = 1; page <= 3; page += 1) {
			walked.push(...(await products.listPage({ page, limit: 3 })).data.map((record) => record._id));
		}

		expect(walked).toHaveLength(7);
		expect(new Set(walked).size).toBe(7);
		expect(walked).toEqual([...created].sort().reverse());
	});

	it('filters by category, availability and the channel the admin set', async () => {
		await rawProduct({ name: 'all on', category: 'c1', salesChannel: 'all' });
		await rawProduct({ name: 'online off', category: 'c1', salesChannel: 'online', available: false });
		await rawProduct({ name: 'legacy' });
		await rawProduct({ name: 'offline', category: 'c2', salesChannel: 'offline' });

		const list = async (filter) => names((await products.listPage({ page: 1, limit: 50, ...filter })).data).sort();

		expect(await list({ category: 'c1' })).toEqual(['all on', 'online off']);
		expect(await list({ available: false })).toEqual(['online off']);
		expect(await list({ salesChannel: 'all' })).toEqual(['all on', 'legacy']);
		expect(await list({ salesChannel: 'offline' })).toEqual(['offline']);
		expect(await list({ salesChannel: 'nowhere' })).toEqual([]);
	});

	it('serialises: dates stay dates and no store internals leak', async () => {
		await rawProduct({ createdAt: at(1) });

		const [record] = (await products.listPage({ page: 1, limit: 5 })).data;

		expect(record.createdAt).toBeInstanceOf(Date);
		expect(typeof record._id).toBe('string');
		expect(() => JSON.stringify(record)).not.toThrow();
		expect(record).not.toHaveProperty('seq');
	});
});

describe('product writes and reads', () => {
	it('creates a complete record with the schema defaults, trimmed text and no computed fields', async () => {
		const created = await products.create({ name: '  Áo  ', category: 'c', price: 5, description: ' mô tả ' }, 3, null);

		expect(created).toMatchObject({
			name: 'Áo', description: 'mô tả', price: 5, category: 'c', imageUrl: '/fallback-product.png', available: true, isActive: true,
			salesChannel: 'all', stockQuantity: 3, minOrderQuantity: 1, maxOrderQuantity: null, tags: [], featured: false,
		});
		expect(typeof created._id).toBe('string');
		for (const absent of ['sku', 'weight', 'dimensions', 'salePrice', 'saleStartDate', 'saleEndDate', 'inStock', 'id']) {
			expect(created, absent).not.toHaveProperty(absent);
		}
		expect(withoutVersion(created)).toEqual([
			'_id', 'available', 'category', 'createdAt', 'description', 'featured', 'imageUrl', 'images', 'isActive', 'maxOrderQuantity', 'minOrderQuantity',
			'name', 'options', 'price', 'publicCode', 'salesChannel', 'slug', 'stockQuantity', 'storefrontId', 'tags', 'updatedAt',
			'variants',
		]);
		expect(created).toMatchObject({ images: [], options: [] });
		expect(created.variants).toEqual([{ _id: expect.any(String), optionValues: [], effectivePrice: 5, isActive: true, stockQuantity: 3 }]);
		expect(await products.findById(created._id)).toEqual(created);
		expect((await findProduct(created._id)).stockQuantity).toBe(3);
	});

	it('stores the optional fields an import brings', async () => {
		const created = await products.create({
			...VALID_PRODUCT, sku: ' SKU-9 ', tags: [' a ', 'b'], weight: 2.5, dimensions: { length: 1, width: 2 }, salePrice: 900,
			saleStartDate: '2026-01-01T00:00:00.000Z', saleEndDate: new Date('2026-02-01T00:00:00.000Z'), maxOrderQuantity: 4, featured: true,
		}, 0, null);

		expect(created).toMatchObject({ sku: 'SKU-9', tags: ['a', 'b'], weight: 2.5, dimensions: { length: 1, width: 2 }, salePrice: 900, maxOrderQuantity: 4, featured: true });
		expect(created.saleStartDate).toEqual(new Date('2026-01-01T00:00:00.000Z'));
		expect(created.saleEndDate).toEqual(new Date('2026-02-01T00:00:00.000Z'));
	});

	it('reports every rule a create breaks, as the schema did', async () => {
		const error = await failure(products.create({ name: '', price: -5, category: '', minOrderQuantity: 0, salesChannel: 'weird' }, 0, null));

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(fieldsOf(error).sort()).toEqual(['category', 'minOrderQuantity', 'name', 'price', 'salesChannel']);
		for (const entry of error.fieldErrors) expect(typeof entry.message).toBe('string');
	});

	it.each([
		['a fractional price', { price: 1.5 }, 'price'],
		['a too long name', { name: 'x'.repeat(101) }, 'name'],
		['a too long description', { description: 'x'.repeat(501) }, 'description'],
		['a negative weight', { weight: -1 }, 'weight'],
		['a negative sale price', { salePrice: -1 }, 'salePrice'],
	])('refuses %s', async (_label, change, field) => {
		const error = await failure(products.create({ ...VALID_PRODUCT, ...change }, 0, null));

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(fieldsOf(error)).toContain(field);
		expect(await countRows('product')).toBe(0);
	});

	it('reports a taken sku as a duplicate on that column', async () => {
		await products.create({ ...VALID_PRODUCT, sku: 'SKU-1' }, 0, null);

		const error = await failure(products.create({ ...VALID_PRODUCT, name: 'Other', sku: 'SKU-1' }, 0, null));

		expect(error).toBeInstanceOf(DuplicateKeyError);
		expect(error.fields).toEqual(['sku']);
	});

	it('writes the product and its opening movement in one transaction, or neither', async () => {
		const created = await data.withTransaction(async (tx) => {
			const product = await products.create(VALID_PRODUCT, 5, tx);
			await recordAppliedOpening({ productId: product._id, quantity: 5 }, txOptions(tx));
			return product;
		});

		expect(await stockOf(created._id)).toBe(5);
		expect(await movements({ productId: created._id })).toEqual([expect.objectContaining({ type: 'opening', status: 'applied', delta: 5 })]);

		await expect(withTransaction(async (tx) => {
			const product = await products.create({ ...VALID_PRODUCT, name: 'Rolled back' }, 7, tx);
			await recordAppliedOpening({ productId: product._id, quantity: 7 }, txOptions(tx));
			throw new Error('route failed afterwards');
		})).rejects.toThrow('route failed afterwards');
		expect(await countRows('product')).toBe(1);
		expect(await countRows('movement')).toBe(1);
	});

	it('changes only the editable fields on update and returns the stored result', async () => {
		const created = await products.create({ ...VALID_PRODUCT, sku: 'KEEP' }, 4, null);

		const updated = await products.update(created._id, {
			price: 2500, category: 'new', available: false, salesChannel: 'online', stockQuantity: 99, sku: 'CHANGED', isActive: false, tags: ['x'],
		});

		expect(updated).toMatchObject({ price: 2500, category: 'new', available: false, salesChannel: 'online', stockQuantity: 4, sku: 'KEEP', isActive: true, tags: [] });
		expect(await products.findById(created._id)).toEqual(updated);
		expect(await stockOf(created._id)).toBe(4);
	});

	it('validates an update against the same rules and leaves the row alone when it fails', async () => {
		const created = await products.create(VALID_PRODUCT, 0, null);

		const error = await failure(products.update(created._id, { price: -1, name: '' }));

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(fieldsOf(error).sort()).toEqual(['name', 'price']);
		expect(await products.findById(created._id)).toEqual(created);
	});

	it('answers null or false for a product that does not exist', async () => {
		const missing = newId();

		expect(await products.findById(missing)).toBeNull();
		expect(await products.update(missing, { name: 'Nobody' })).toBeNull();
		expect(await products.update(missing, { price: 1 })).toBeNull();
		expect(await products.remove(missing)).toBe(false);
		expect(await products.exists(missing)).toBe(false);
	});

	it('removes a product once', async () => {
		const created = await products.create(VALID_PRODUCT, 0, null);

		expect(await products.remove(created._id)).toBe(true);
		expect(await products.remove(created._id)).toBe(false);
		expect(await findProduct(created._id)).toBeNull();
	});

	it('reports an id that is not an id as InvalidIdError carrying the field and the value', async () => {
		for (const call of [() => products.findById('not-an-id'), () => products.update('not-an-id', { price: 1 }), () => products.remove('not-an-id')]) {
			const error = await failure(call());
			expect(error).toBeInstanceOf(InvalidIdError);
			expect(error.value).toBe('not-an-id');
			expect(error.path).toBe('_id');
		}
	});

	it('answers the small lookups', async () => {
		const a = await rawProduct({ name: 'Alpha', category: 'x', available: true, stockQuantity: 5 });
		const b = await rawProduct({ name: 'Beta', category: 'y', available: false, stockQuantity: -2 });
		const c = await rawProduct({ name: 'Gamma', category: 'x', available: true, stockQuantity: 3 });

		expect(await products.exists(a._id)).toBe(true);
		expect(await products.existsByName('Beta')).toBe(true);
		expect(await products.existsByName('beta')).toBe(false);
		expect((await products.listCategories()).sort()).toEqual(['x', 'y']);
		expect((await products.listIds()).sort()).toEqual([a._id, b._id, c._id].sort());
		expect((await products.listCategoryById()).find((row) => row._id === b._id)).toEqual({ _id: b._id, category: 'y' });
		expect(await products.summarizeCatalog()).toEqual({ total: 3, active: 2, totalStock: 6 });
	});

	it('summarises an empty catalogue as zeros', async () => {
		expect(await products.summarizeCatalog()).toEqual({ total: 0, active: 0, totalStock: 0 });
	});
});

describe('combo writes and reads', () => {
	it('creates a combo with its requirements in order, each with its own id, and no computed fields', async () => {
		const created = await combos.create({ ...VALID_COMBO, description: ' hai món ', priority: 3 });

		expect(created).toMatchObject({ name: 'Bộ đôi', description: 'hai món', price: 5000, isActive: true, salesChannel: 'all', priority: 3 });
		expect(created.categoryRequirements.map(({ category, quantity }) => [category, quantity])).toEqual([['a', 2], ['b', 1]]);
		const ids = created.categoryRequirements.map((requirement) => String(requirement._id));
		expect(new Set(ids).size).toBe(2);
		expect(withoutVersion(created)).toEqual([
			'_id', 'categoryRequirements', 'createdAt', 'description', 'isActive', 'name', 'price', 'priority', 'publicCode', 'salesChannel', 'slug', 'storefrontIds', 'updatedAt',
		]);
		expect(created).not.toHaveProperty('totalRequiredQuantity');
		expect(created).not.toHaveProperty('id');
		expect(await combos.findById(created._id)).toEqual(created);

		const stored = await findCombo(created._id);
		expect(stored.categoryRequirements.map((requirement) => [String(requirement._id), requirement.category])).toEqual([[ids[0], 'a'], [ids[1], 'b']]);
	});

	it('leaves description absent when none was given', async () => {
		expect(await combos.create(VALID_COMBO)).not.toHaveProperty('description');
	});

	it('replaces the requirements as a whole on update and keeps them when not given', async () => {
		const created = await combos.create(VALID_COMBO);

		const kept = await combos.update(created._id, { price: 100 });
		const replaced = await combos.update(created._id, { categoryRequirements: [{ category: 'c', quantity: 4 }] });

		expect(kept.categoryRequirements.map((requirement) => String(requirement._id))).toEqual(created.categoryRequirements.map((requirement) => String(requirement._id)));
		expect(replaced.categoryRequirements.map(({ category, quantity }) => [category, quantity])).toEqual([['c', 4]]);
		expect((await findCombo(created._id)).categoryRequirements).toHaveLength(1);
		expect(await combos.findById(created._id)).toEqual(replaced);
	});

	it('refuses a combo without a usable requirement, naming the field', async () => {
		const created = await combos.create(VALID_COMBO);

		for (const categoryRequirements of [[], [{ category: 'a', quantity: 0 }], [{ category: '', quantity: 1 }]]) {
			const onCreate = await failure(combos.create({ ...VALID_COMBO, categoryRequirements }));
			const onUpdate = await failure(combos.update(created._id, { categoryRequirements }));
			expect(onCreate).toBeInstanceOf(RecordValidationError);
			expect(onUpdate).toBeInstanceOf(RecordValidationError);
		}
		expect((await findCombo(created._id)).categoryRequirements).toHaveLength(2);
		expect(await countRows('combo')).toBe(1);
	});

	it('reports a value that cannot be stored as a number as a validation error on that field', async () => {
		const created = await combos.create(VALID_COMBO);

		const error = await failure(combos.update(created._id, { price: 'abc' }));

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(fieldsOf(error)).toEqual(['price']);
	});

	// The requirements live in their own rows, so concurrent edits are serialised by the combo row lock.
	it('serialises edits of one combo that replace its requirements at the same time', async () => {
		const created = await combos.create(VALID_COMBO);
		const lists = Array.from({ length: 8 }, (_, i) => Array.from({ length: (i % 3) + 1 }, (__, j) => ({ category: `c${i}`, quantity: j + 1 })));

		await Promise.all(lists.map((categoryRequirements) => combos.update(created._id, { categoryRequirements })));

		const stored = (await findCombo(created._id)).categoryRequirements.map(({ category, quantity }) => ({ category, quantity }));
		expect(lists).toContainEqual(stored);
	});

	it('answers null or false for a combo that does not exist and refuses a bad id', async () => {
		const missing = newId();

		expect(await combos.findById(missing)).toBeNull();
		expect(await combos.update(missing, { price: 1 })).toBeNull();
		expect(await combos.remove(missing)).toBe(false);
		expect(await combos.exists(missing)).toBe(false);
		const error = await failure(combos.findById('not-an-id'));
		expect(error).toBeInstanceOf(InvalidIdError);
		expect(error.value).toBe('not-an-id');
		expect(error.path).toBe('_id');
	});

	it('removes a combo once and lists names', async () => {
		const first = await combos.create(VALID_COMBO);
		await combos.create({ ...VALID_COMBO, name: 'Second' });

		expect((await combos.listNames()).sort()).toEqual(['Bộ đôi', 'Second']);
		expect(await combos.exists(first._id)).toBe(true);
		expect(await combos.remove(first._id)).toBe(true);
		expect(await combos.remove(first._id)).toBe(false);
		expect(await findCombo(first._id)).toBeNull();
	});
});

describe('pricing over the catalogue repositories', () => {
	it('prices a cart and applies a combo whatever form the cart ids are in, handing back ids that stringify to the stored ones', async () => {
		const legacyHex = '6acc24c7924609c6bfb78bef';
		const pen = await products.create({ _id: legacyHex, name: 'Pen', price: 1000, category: 'pens' }, 0, null);
		const cup = await products.create({ name: 'Cup', price: 2000, category: 'cups' }, 0, null);
		const combo = await combos.create({ name: 'Desk set', price: 2500, categoryRequirements: [{ category: 'pens', quantity: 1 }, { category: 'cups', quantity: 1 }] });

		const priced = await computeOrderPricing(
			[{ productId: legacyHex.toUpperCase(), quantity: 1 }, { productId: cup._id, quantity: 1 }],
			{ channel: 'online' }
		);

		expect(normalizeRecordId(legacyHex)).toBe(pen._id);
		expect(priced.totalAmount).toBe(2500);
		expect(priced.savings).toBe(500);
		expect(priced.orderItems.map((line) => [String(line.productId), String(line.comboId), line.fromCombo]).sort()).toEqual(
			[[pen._id, combo._id, true], [cup._id, combo._id, true]].sort()
		);
		expect(priced.comboInfo.combos.map((entry) => String(entry.comboId))).toEqual([combo._id]);
		expect([...priced.products.keys()].sort()).toEqual([pen._id, cup._id].sort());
	});

	it('reports a product that is only sold on the other channel as a channel mismatch', async () => {
		const offline = await products.create({ name: 'Counter only', price: 10, category: 'c', salesChannel: 'offline' }, 0, null);

		const error = await failure(computeOrderPricing([{ productId: offline._id, quantity: 1 }], { channel: 'online' }));

		expect(error.code).toBe('PRODUCT_CHANNEL_MISMATCH');
	});
});
