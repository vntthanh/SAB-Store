/**
 * The storefront repositories on Postgres: access rules, display order, the
 * invariants the database cannot hold (never delete a used storefront, never
 * deactivate the last one), email lists and the storefront filter of the catalogue.
 */
const { POSTGRES } = require('../helpers/backend');
const { DEFAULT_STOREFRONT_ID } = require('../../data/default-storefront');
const { isDuplicateKeyOn } = require('../../data/errors');

describe.skipIf(!POSTGRES)('storefront repositories', () => {
	let prisma;
	let data;
	let factories;
	let storefronts;
	let emailLists;

	beforeAll(() => {
		({ prisma } = require('../../lib/prisma'));
		data = require('../../data');
		factories = require('../helpers/factories');
		({ storefronts, emailLists } = data);
	});

	let counter = 0;
	const makeStorefront = (fields = {}) => {
		counter += 1;
		return storefronts.create({ slug: `shop-${counter}`, name: `Shop ${counter}`, ...fields });
	};
	const makePrivate = (fields = {}) => makeStorefront({ visibility: 'PRIVATE', ...fields });

	describe('viewerCanAccess', () => {
		let shop;
		let list;

		beforeEach(async () => {
			shop = await makePrivate();
			list = await emailLists.create({ name: 'Lop A' });
			await emailLists.addEntries(list._id, ['member@gmail.com']);
			await storefronts.addRule({ storefrontId: shop._id, type: 'EMAIL', value: 'one@gmail.com' });
			await storefronts.addRule({ storefrontId: shop._id, type: 'DOMAIN', value: 'sab.edu.vn' });
			await storefronts.addRule({ storefrontId: shop._id, type: 'LIST', emailListId: list._id });
		});

		it.each([
			['an address named by an EMAIL rule', 'one@gmail.com', true],
			['an address of a listed DOMAIN', 'anyone@sab.edu.vn', true],
			['an entry of a LIST rule', 'member@gmail.com', true],
			['an address no rule names', 'stranger@gmail.com', false],
			['a subdomain of a listed domain', 'x@mail.sab.edu.vn', false],
			['a domain that merely ends the same way', 'x@evilsab.edu.vn', false],
			['the domain text as the local part', 'sab.edu.vn@gmail.com', false],
			['upper case and padding', '  ONE@Gmail.COM ', true],
			['upper case domain', 'Someone@SAB.EDU.VN', true],
			['upper case list entry', 'MEMBER@GMAIL.COM', true],
			['something that is not an address', 'sab.edu.vn', false],
			['an address with a second at sign', 'a@b@sab.edu.vn', false],
			['nothing', undefined, false]
		])('%s -> %s', async (_label, email, expected) => {
			expect(await storefronts.viewerCanAccess(shop._id, email)).toBe(expected);
		});

		it('admits nobody to a storefront without rules, and ignores another storefront\'s rules', async () => {
			const other = await makePrivate();

			expect(await storefronts.viewerCanAccess(other._id, 'one@gmail.com')).toBe(false);
			expect(await storefronts.viewerCanAccess(other._id, 'anyone@sab.edu.vn')).toBe(false);
		});

		it('stops admitting an address removed from the list, and a deleted list\'s members', async () => {
			const [{ _id: entryId }] = (await emailLists.entriesPage(list._id, { page: 1, limit: 10 })).data;
			await emailLists.removeEntry(list._id, entryId);
			expect(await storefronts.viewerCanAccess(shop._id, 'member@gmail.com')).toBe(false);

			await emailLists.addEntries(list._id, ['member@gmail.com']);
			expect(await storefronts.viewerCanAccess(shop._id, 'member@gmail.com')).toBe(true);
			await emailLists.remove(list._id);
			expect(await storefronts.viewerCanAccess(shop._id, 'member@gmail.com')).toBe(false);
			expect(await storefronts.listRules(shop._id)).toHaveLength(2);
		});

		it('answers with one statement', async () => {
			const spy = vi.spyOn(prisma, '$queryRaw');
			try {
				await storefronts.viewerCanAccess(shop._id, 'member@gmail.com');
				expect(spy).toHaveBeenCalledTimes(1);
			} finally {
				spy.mockRestore();
			}
		});
	});

	describe('accessibleIds', () => {
		it('lists the active private storefronts a rule admits the address to, in display order', async () => {
			const first = await makePrivate();
			const second = await makePrivate();
			const hidden = await makePrivate();
			const inactive = await makePrivate();
			const publicShop = await makeStorefront();
			for (const shop of [first, second, inactive, publicShop]) {
				await storefronts.addRule({ storefrontId: shop._id, type: 'DOMAIN', value: 'sab.edu.vn' });
			}
			await storefronts.addRule({ storefrontId: hidden._id, type: 'EMAIL', value: 'other@sab.edu.vn' });
			await storefronts.update(inactive._id, { isActive: false });
			await storefronts.reorder([second._id, first._id]);

			expect(await storefronts.accessibleIds('Me@SAB.edu.vn')).toEqual([second._id, first._id]);
			expect(await storefronts.accessibleIds('me@gmail.com')).toEqual([]);
			expect(await storefronts.accessibleIds('not an address')).toEqual([]);
		});

		it('answers with one statement', async () => {
			const spy = vi.spyOn(prisma, '$queryRaw');
			try {
				await storefronts.accessibleIds('me@sab.edu.vn');
				expect(spy).toHaveBeenCalledTimes(1);
			} finally {
				spy.mockRestore();
			}
		});
	});

	describe('storefront records', () => {
		it('creates at the end of the display order, with an absent description, and lists active ones', async () => {
			const a = await makeStorefront({ description: 'Mô tả' });
			const b = await makeStorefront({ isActive: false });

			expect(a.description).toBe('Mô tả');
			expect(b).not.toHaveProperty('description');
			expect(b.sortOrder).toBe(a.sortOrder + 1);
			expect((await storefronts.listAll()).map((shop) => shop._id)).toEqual([DEFAULT_STOREFRONT_ID, a._id, b._id]);
			expect((await storefronts.listActive()).map((shop) => shop._id)).toEqual([DEFAULT_STOREFRONT_ID, a._id]);
			expect((await storefronts.findBySlug(a.slug))._id).toBe(a._id);
			expect(await storefronts.findBySlug('missing')).toBeNull();
			expect((await storefronts.findById(b._id)).slug).toBe(b.slug);
		});

		it('refuses a bad slug, a missing name and a taken slug', async () => {
			await expect(storefronts.create({ slug: 'Bad Slug', name: 'x' })).rejects.toMatchObject({ name: 'RecordValidationError', fieldErrors: [expect.objectContaining({ field: 'slug' })] });
			await expect(storefronts.create({ slug: 'ok-slug' })).rejects.toMatchObject({ name: 'RecordValidationError', fieldErrors: [expect.objectContaining({ field: 'name' })] });
			await storefronts.create({ slug: 'taken', name: 'One' });
			const error = await storefronts.create({ slug: 'taken', name: 'Two' }).catch((caught) => caught);
			expect(isDuplicateKeyOn(error, 'slug')).toBe(true);
		});

		it('updates only the editable fields and returns null for an unknown storefront', async () => {
			const shop = await makeStorefront();

			const updated = await storefronts.update(shop._id, { name: 'Renamed', visibility: 'PRIVATE', sortOrder: 99, id: 'x' });

			expect(updated).toMatchObject({ _id: shop._id, name: 'Renamed', visibility: 'PRIVATE', sortOrder: shop.sortOrder });
			expect(await storefronts.update('01a173f3-7280-71fd-b24f-000000000000', { name: 'x' })).toBeNull();
		});

		it('renumbers the listed storefronts by index in one transaction, and changes nothing on a bad list', async () => {
			const a = await makeStorefront();
			const b = await makeStorefront();

			const ordered = await storefronts.reorder([b._id, DEFAULT_STOREFRONT_ID, a._id]);

			expect(ordered.map((shop) => [shop._id, shop.sortOrder])).toEqual([[b._id, 0], [DEFAULT_STOREFRONT_ID, 1], [a._id, 2]]);
			await expect(storefronts.reorder([a._id, '01a173f3-7280-71fd-b24f-000000000000'])).rejects.toMatchObject({ name: 'RecordValidationError' });
			await expect(storefronts.reorder([a._id, a._id])).rejects.toMatchObject({ name: 'RecordValidationError' });
			expect((await storefronts.listAll()).map((shop) => shop._id)).toEqual([b._id, DEFAULT_STOREFRONT_ID, a._id]);
		});

		it('survives two overlapping reorders listed in opposite orders', async () => {
			const a = await makeStorefront();
			const b = await makeStorefront();

			const results = await Promise.allSettled([
				storefronts.reorder([a._id, b._id, DEFAULT_STOREFRONT_ID]),
				storefronts.reorder([DEFAULT_STOREFRONT_ID, b._id, a._id])
			]);

			expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
			expect((await storefronts.listAll()).map((shop) => shop.sortOrder)).toEqual([0, 1, 2]);
		});
	});

	describe('removal and deactivation', () => {
		it('refuses to delete a storefront that products, combos or orders use, and says how many', async () => {
			const withProduct = await makeStorefront();
			const withCombo = await makeStorefront();
			const withOrder = await makeStorefront();
			await factories.makeProduct({ storefrontId: withProduct._id });
			await factories.makeCombo({ storefrontIds: [DEFAULT_STOREFRONT_ID, withCombo._id] });
			await factories.makeOrder({ storefrontId: withOrder._id });

			await expect(storefronts.remove(withProduct._id)).rejects.toMatchObject({ name: 'ConflictError', code: 'STOREFRONT_IN_USE', details: { products: 1, combos: 0, orders: 0 } });
			await expect(storefronts.remove(withCombo._id)).rejects.toMatchObject({ code: 'STOREFRONT_IN_USE', details: { products: 0, combos: 1, orders: 0 } });
			await expect(storefronts.remove(withOrder._id)).rejects.toMatchObject({ code: 'STOREFRONT_IN_USE', details: { products: 0, combos: 0, orders: 1 } });
			expect(await storefronts.findById(withOrder._id)).not.toBeNull();
		});

		it('deletes an unused storefront with its rules, and reports a missing one as false', async () => {
			const shop = await makePrivate();
			await storefronts.addRule({ storefrontId: shop._id, type: 'EMAIL', value: 'a@b.vn' });

			expect(await storefronts.remove(shop._id)).toBe(true);

			expect(await storefronts.findById(shop._id)).toBeNull();
			expect(await prisma.storefrontAccessRule.count()).toBe(0);
			expect(await storefronts.remove(shop._id)).toBe(false);
		});

		it('keeps one storefront active: neither deactivating nor deleting the last one', async () => {
			await expect(storefronts.update(DEFAULT_STOREFRONT_ID, { isActive: false })).rejects.toMatchObject({ name: 'ConflictError', code: 'LAST_ACTIVE_STOREFRONT' });
			const inactive = await makeStorefront({ isActive: false });
			await expect(storefronts.update(DEFAULT_STOREFRONT_ID, { isActive: false })).rejects.toMatchObject({ code: 'LAST_ACTIVE_STOREFRONT' });
			expect(await storefronts.remove(inactive._id)).toBe(true);

			const second = await makeStorefront();
			expect((await storefronts.update(DEFAULT_STOREFRONT_ID, { isActive: false })).isActive).toBe(false);
			await expect(storefronts.update(second._id, { isActive: false })).rejects.toMatchObject({ code: 'LAST_ACTIVE_STOREFRONT' });
			await expect(storefronts.remove(second._id)).rejects.toMatchObject({ code: 'LAST_ACTIVE_STOREFRONT' });
			expect((await storefronts.listActive()).map((shop) => shop._id)).toEqual([second._id]);
		});

		it('never deletes the default storefront, even when it is inactive and unused, but lets it be deactivated', async () => {
			await makeStorefront();

			await expect(storefronts.remove(DEFAULT_STOREFRONT_ID)).rejects.toMatchObject({ name: 'ConflictError', code: 'DEFAULT_STOREFRONT' });
			expect((await storefronts.update(DEFAULT_STOREFRONT_ID, { isActive: false })).isActive).toBe(false);
			await expect(storefronts.remove(DEFAULT_STOREFRONT_ID)).rejects.toMatchObject({ code: 'DEFAULT_STOREFRONT' });
			expect(await storefronts.findById(DEFAULT_STOREFRONT_ID)).not.toBeNull();
		});

		it('never ends with zero active storefronts when an activation races a deletion', async () => {
			const inactive = await makeStorefront({ isActive: false });
			const only = await makeStorefront();
			await storefronts.update(DEFAULT_STOREFRONT_ID, { isActive: false });

			const results = await Promise.allSettled([
				storefronts.update(inactive._id, { isActive: true }),
				storefronts.remove(only._id)
			]);

			expect((await storefronts.listActive()).length).toBeGreaterThanOrEqual(1);
			expect(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'LAST_ACTIVE_STOREFRONT')).toBe(true);
		});

		it('lets only one of two concurrent deactivations through', async () => {
			const second = await makeStorefront();

			const results = await Promise.allSettled([
				storefronts.update(DEFAULT_STOREFRONT_ID, { isActive: false }),
				storefronts.update(second._id, { isActive: false })
			]);

			expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(results.find((result) => result.status === 'rejected').reason).toMatchObject({ code: 'LAST_ACTIVE_STOREFRONT' });
			expect(await storefronts.listActive()).toHaveLength(1);
		});
	});

	describe('access rules', () => {
		it('folds EMAIL and DOMAIN values to lowercase and lists each rule with its list name and size', async () => {
			const shop = await makePrivate();
			const list = await emailLists.create({ name: 'Danh sách' });
			await emailLists.addEntries(list._id, ['a@x.vn', 'b@x.vn']);

			const email = await storefronts.addRule({ storefrontId: shop._id, type: 'EMAIL', value: ' Mixed@Case.VN ' });
			await storefronts.addRule({ storefrontId: shop._id, type: 'DOMAIN', value: 'SAB.edu.vn' });
			await storefronts.addRule({ storefrontId: shop._id, type: 'LIST', emailListId: list._id });

			expect(email).toMatchObject({ storefrontId: shop._id, type: 'EMAIL', value: 'mixed@case.vn' });
			expect(email).not.toHaveProperty('emailListId');
			const rules = await storefronts.listRules(shop._id);
			expect(rules.map((rule) => [rule.type, rule.value ?? null])).toEqual([['EMAIL', 'mixed@case.vn'], ['DOMAIN', 'sab.edu.vn'], ['LIST', null]]);
			expect(rules[2]).toMatchObject({ emailListId: list._id, emailListName: 'Danh sách', entryCount: 2 });
		});

		it('raises a duplicate on the value for EMAIL and DOMAIN, whatever the case, and on the list for LIST', async () => {
			const shop = await makePrivate();
			const list = await emailLists.create({ name: 'L' });
			await storefronts.addRule({ storefrontId: shop._id, type: 'EMAIL', value: 'a@b.vn' });
			await storefronts.addRule({ storefrontId: shop._id, type: 'DOMAIN', value: 'b.vn' });
			await storefronts.addRule({ storefrontId: shop._id, type: 'LIST', emailListId: list._id });

			const email = await storefronts.addRule({ storefrontId: shop._id, type: 'EMAIL', value: 'A@B.vn' }).catch((caught) => caught);
			const domain = await storefronts.addRule({ storefrontId: shop._id, type: 'DOMAIN', value: 'B.VN' }).catch((caught) => caught);
			const again = await storefronts.addRule({ storefrontId: shop._id, type: 'LIST', emailListId: list._id }).catch((caught) => caught);

			expect(isDuplicateKeyOn(email, 'value')).toBe(true);
			expect(isDuplicateKeyOn(domain, 'value')).toBe(true);
			expect(isDuplicateKeyOn(again, 'emailListId')).toBe(true);
			expect(await storefronts.listRules(shop._id)).toHaveLength(3);
		});

		it('allows the same rule on another storefront', async () => {
			const one = await makePrivate();
			const two = await makePrivate();

			await storefronts.addRule({ storefrontId: one._id, type: 'DOMAIN', value: 'b.vn' });

			await expect(storefronts.addRule({ storefrontId: two._id, type: 'DOMAIN', value: 'b.vn' })).resolves.toMatchObject({ type: 'DOMAIN' });
		});

		it.each([
			['an unknown type', { type: 'REGEX', value: 'a' }, 'type'],
			['an EMAIL that is not an address', { type: 'EMAIL', value: 'nope' }, 'value'],
			['a DOMAIN with an at sign', { type: 'DOMAIN', value: '@sab.edu.vn' }, 'value'],
			['a DOMAIN without a dot', { type: 'DOMAIN', value: 'localhost' }, 'value'],
			['a LIST without a list', { type: 'LIST' }, 'emailListId'],
			['an EMAIL that names a list', { type: 'EMAIL', value: 'a@b.vn', emailListId: '01a173f3-7280-71fd-b24f-000000000001' }, 'emailListId']
		])('refuses %s', async (_label, rule, field) => {
			const shop = await makePrivate();

			await expect(storefronts.addRule({ storefrontId: shop._id, ...rule })).rejects.toMatchObject({
				name: 'RecordValidationError', fieldErrors: expect.arrayContaining([expect.objectContaining({ field })])
			});
		});

		it('reports a missing storefront or list as a reference conflict, and removes a rule only from its own storefront', async () => {
			const shop = await makePrivate();
			const other = await makePrivate();
			const missing = '01a173f3-7280-71fd-b24f-000000000000';

			await expect(storefronts.addRule({ storefrontId: missing, type: 'DOMAIN', value: 'b.vn' })).rejects.toMatchObject({ name: 'ConflictError', code: 'REFERENCE_VIOLATION' });
			await expect(storefronts.addRule({ storefrontId: shop._id, type: 'LIST', emailListId: missing })).rejects.toMatchObject({ code: 'REFERENCE_VIOLATION' });

			const rule = await storefronts.addRule({ storefrontId: shop._id, type: 'DOMAIN', value: 'b.vn' });
			expect(await storefronts.removeRule(other._id, rule._id)).toBe(false);
			expect(await storefronts.removeRule(shop._id, rule._id)).toBe(true);
			expect(await storefronts.listRules(shop._id)).toEqual([]);
		});
	});

	describe('email lists', () => {
		it('counts what an add brings in, skipping repeats, other spellings and addresses already there', async () => {
			const list = await emailLists.create({ name: 'Lớp', description: 'Khoá 1' });

			const first = await emailLists.addEntries(list._id, ['a@x.vn', 'A@X.vn', ' b@x.vn ', 'c@x.vn']);
			const second = await emailLists.addEntries(list._id, ['a@x.vn', 'd@x.vn']);

			expect(first).toEqual({ added: 3, skipped: 1 });
			expect(second).toEqual({ added: 1, skipped: 1 });
			expect((await emailLists.findById(list._id))).toMatchObject({ name: 'Lớp', description: 'Khoá 1', entryCount: 4, ruleCount: 0 });
		});

		it('adds nothing when one entry is not an address, and reports an unknown list as null', async () => {
			const list = await emailLists.create({ name: 'Lớp' });

			await expect(emailLists.addEntries(list._id, ['a@x.vn', 'broken'])).rejects.toMatchObject({
				name: 'RecordValidationError', fieldErrors: [expect.objectContaining({ field: 'emails.1' })]
			});
			expect(await emailLists.addEntries('01a173f3-7280-71fd-b24f-000000000000', ['a@x.vn'])).toBeNull();
			expect((await emailLists.findById(list._id)).entryCount).toBe(0);
		});

		it('pages addresses by address then id, with the standard meta, and searches literally', async () => {
			const list = await emailLists.create({ name: 'Lớp' });
			await emailLists.addEntries(list._id, ['e@x.vn', 'a@x.vn', 'c@x.vn', 'd@x.vn', 'b@y.vn']);

			const second = await emailLists.entriesPage(list._id, { page: 2, limit: 2 });
			const past = await emailLists.entriesPage(list._id, { page: 4, limit: 2 });
			const found = await emailLists.entriesPage(list._id, { page: 1, limit: 10, search: ' @Y.vn ' });
			const literal = await emailLists.entriesPage(list._id, { page: 1, limit: 10, search: '%' });
			const empty = await emailLists.entriesPage('01a173f3-7280-71fd-b24f-000000000000', { page: 1, limit: 10 });

			expect(second.data.map((entry) => entry.email)).toEqual(['c@x.vn', 'd@x.vn']);
			expect(second.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
			expect(second.data[0]).toMatchObject({ emailListId: list._id });
			expect(past.data).toEqual([]);
			expect(found.data.map((entry) => entry.email)).toEqual(['b@y.vn']);
			expect(found.meta.total).toBe(1);
			expect(literal.data).toEqual([]);
			expect(empty).toEqual({ data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } });
		});

		it('removes one address of its own list, or all of them', async () => {
			const list = await emailLists.create({ name: 'A' });
			const other = await emailLists.create({ name: 'B' });
			await emailLists.addEntries(list._id, ['a@x.vn', 'b@x.vn']);
			await emailLists.addEntries(other._id, ['a@x.vn']);
			const [{ _id: entryId }] = (await emailLists.entriesPage(list._id, { page: 1, limit: 10 })).data;

			expect(await emailLists.removeEntry(other._id, entryId)).toBe(false);
			expect(await emailLists.removeEntry(list._id, entryId)).toBe(true);
			expect(await emailLists.clear(list._id)).toBe(1);
			expect((await emailLists.findById(other._id)).entryCount).toBe(1);
		});

		it('lists by name with entry and rule counts, renames, refuses a taken or empty name, and deletes with the rules that name it', async () => {
			const shop = await makePrivate();
			const b = await emailLists.create({ name: 'B list' });
			const a = await emailLists.create({ name: 'A list' });
			await emailLists.addEntries(b._id, ['x@x.vn']);
			await storefronts.addRule({ storefrontId: shop._id, type: 'LIST', emailListId: b._id });

			expect((await emailLists.list()).map((entry) => [entry.name, entry.entryCount, entry.ruleCount])).toEqual([['A list', 0, 0], ['B list', 1, 1]]);
			expect((await emailLists.update(a._id, { name: 'Renamed', description: 'mô tả' }))).toMatchObject({ name: 'Renamed', description: 'mô tả' });
			expect(isDuplicateKeyOn(await emailLists.update(a._id, { name: 'B list' }).catch((caught) => caught), 'name')).toBe(true);
			expect(isDuplicateKeyOn(await emailLists.create({ name: 'B list' }).catch((caught) => caught), 'name')).toBe(true);
			await expect(emailLists.create({ name: '  ' })).rejects.toMatchObject({ name: 'RecordValidationError' });
			expect(await emailLists.update('01a173f3-7280-71fd-b24f-000000000000', { name: 'x' })).toBeNull();

			expect(await emailLists.remove(b._id)).toBe(true);
			expect(await emailLists.remove(b._id)).toBe(false);
			expect(await storefronts.listRules(shop._id)).toEqual([]);
			expect(await prisma.emailListEntry.count()).toBe(0);
		});
	});

	describe('catalogue by storefront', () => {
		it('lists and prices only the products of the named storefront', async () => {
			const other = await makeStorefront();
			const inDefault = await factories.makeProduct({ name: 'In default' });
			const inOther = await factories.makeProduct({ name: 'In other', storefrontId: other._id });

			const names = async (storefrontId) => (await data.products.listSellable('online', { storefrontId })).map((product) => product.name);
			expect(await names(other._id)).toEqual(['In other']);
			expect(await names(DEFAULT_STOREFRONT_ID)).toEqual(['In default']);
			expect((await data.products.listSellable('online')).map((product) => product.name).sort()).toEqual(['In default', 'In other']);
			expect((await data.products.findSellable('online', { storefrontId: other._id })).map((product) => product.name)).toEqual(['In other']);

			const priced = await data.products.findSellableForPricing('online', [inDefault._id, inOther._id], ['name'], undefined, { storefrontId: other._id });
			expect(priced.map((product) => product.name)).toEqual(['In other']);
			expect((await data.products.findSellableForPricing('online', [inDefault._id, inOther._id], ['name'])).length).toBe(2);
		});

		it('moves a product to another storefront, and refuses one that does not exist', async () => {
			const other = await makeStorefront();
			const product = await factories.makeProduct();

			expect((await data.products.update(product._id, { storefrontId: other._id })).storefrontId).toBe(other._id);
			await expect(data.products.update(product._id, { storefrontId: '01a173f3-7280-71fd-b24f-000000000000' })).rejects.toMatchObject({ code: 'REFERENCE_VIOLATION' });
			expect((await data.products.findById(product._id)).storefrontId).toBe(other._id);
		});

		it('lists and prices only the combos linked to the named storefront', async () => {
			const other = await makeStorefront();
			await factories.makeCombo({ name: 'Default only' });
			await factories.makeCombo({ name: 'Other only', storefrontIds: [other._id] });
			await factories.makeCombo({ name: 'Both', storefrontIds: [other._id, DEFAULT_STOREFRONT_ID] });

			const names = async (storefrontId) => (await data.combos.listSellable('online', { storefrontId })).map((combo) => combo.name).sort();
			expect(await names(other._id)).toEqual(['Both', 'Other only']);
			expect(await names(DEFAULT_STOREFRONT_ID)).toEqual(['Both', 'Default only']);
			expect(await names(undefined)).toEqual(['Both', 'Default only', 'Other only']);

			const priced = await data.combos.findSellableForPricing('online', ['name'], undefined, { storefrontId: other._id });
			expect(priced.map((combo) => combo.name).sort()).toEqual(['Both', 'Other only']);
			expect((await data.combos.findSellableForPricing('online', ['name'])).length).toBe(3);
		});

		it('replaces a combo\'s links in one step, sorted, and refuses an empty or missing set without changing them', async () => {
			const a = await makeStorefront();
			const b = await makeStorefront();
			const combo = await factories.makeCombo();

			const moved = await data.combos.update(combo._id, { storefrontIds: [b._id, a._id, b._id] });

			expect(moved.storefrontIds).toEqual([a._id, b._id].sort());
			await expect(data.combos.update(combo._id, { storefrontIds: [] })).rejects.toMatchObject({ name: 'RecordValidationError', fieldErrors: [expect.objectContaining({ field: 'storefrontIds' })] });
			await expect(data.combos.update(combo._id, { storefrontIds: null })).rejects.toMatchObject({ name: 'RecordValidationError' });
			await expect(data.combos.update(combo._id, { name: 'Changed', storefrontIds: [a._id, '01a173f3-7280-71fd-b24f-000000000000'] })).rejects.toMatchObject({ code: 'REFERENCE_VIOLATION' });
			const stored = await data.combos.findById(combo._id);
			expect(stored.storefrontIds).toEqual([a._id, b._id].sort());
			expect(stored.name).not.toBe('Changed');
			expect((await data.combos.update(combo._id, { price: 1 })).storefrontIds).toEqual([a._id, b._id].sort());
		});
	});
});
