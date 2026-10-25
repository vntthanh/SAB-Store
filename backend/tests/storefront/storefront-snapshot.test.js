/**
 * Backup and restore of storefronts, their rules and the email lists: a file
 * with them restores to itself, a file from before they existed lands in the
 * default storefront, and a forged file is refused before anything is written
 * (or, where only the database can tell, rolled back whole).
 */
const { POSTGRES } = require('../helpers/backend');
const { DEFAULT_STOREFRONT_ID } = require('../../data/default-storefront');
const { validateSnapshot, buildMetadata, STOREFRONT_SECTIONS } = require('../../data/snapshot');

describe.skipIf(!POSTGRES)('storefront data in the backup file', () => {
	let prisma;
	let data;
	let dataSnapshot;
	let factories;

	beforeAll(() => {
		({ prisma } = require('../../lib/prisma'));
		data = require('../../data');
		({ dataSnapshot } = data);
		factories = require('../helpers/factories');
	});

	const restore = (snapshot) => data.withTransaction((tx) => dataSnapshot.replaceAll(snapshot, tx));
	const problemsOf = (snapshot) => validateSnapshot(buildMetadata(snapshot, new Date()), snapshot);
	const clone = (value) => JSON.parse(JSON.stringify(value));

	/** A store whose private storefront has every kind of rule, a list, a product, a two-storefront combo and an order. */
	async function seedStorefronts() {
		const club = await data.storefronts.create({ slug: 'clb', name: 'Câu lạc bộ', description: 'Riêng tư', visibility: 'PRIVATE' });
		const list = await data.emailLists.create({ name: 'Thành viên', description: 'Khoá 1' });
		await data.emailLists.addEntries(list._id, ['a@x.vn', 'b@x.vn']);
		await data.storefronts.addRule({ storefrontId: club._id, type: 'EMAIL', value: 'one@gmail.com' });
		await data.storefronts.addRule({ storefrontId: club._id, type: 'DOMAIN', value: 'sab.edu.vn' });
		await data.storefronts.addRule({ storefrontId: club._id, type: 'LIST', emailListId: list._id });
		const product = await factories.makeProduct({ name: 'Club badge', storefrontId: club._id });
		const combo = await factories.makeCombo({ storefrontIds: [DEFAULT_STOREFRONT_ID, club._id] });
		const order = await factories.makeOrder({ storefrontId: club._id });
		await factories.makeOrder({ isDirectSale: true });
		return { club, list, product, combo, order };
	}

	it('exports every storefront section, the references on rows, and a file that passes validation', async () => {
		const { club, list, product, combo, order } = await seedStorefronts();

		const snapshot = await dataSnapshot.exportAll();

		expect(STOREFRONT_SECTIONS.every((section) => Array.isArray(snapshot[section]))).toBe(true);
		expect(snapshot.storefronts.map((row) => row._id).sort()).toEqual([DEFAULT_STOREFRONT_ID, club._id].sort());
		expect(snapshot.storefronts.find((row) => row._id === club._id)).toMatchObject({ slug: 'clb', visibility: 'PRIVATE', description: 'Riêng tư', isActive: true });
		expect(snapshot.storefrontAccessRules.map((row) => [row.type, row.value ?? null]).sort()).toEqual([['DOMAIN', 'sab.edu.vn'], ['EMAIL', 'one@gmail.com'], ['LIST', null]]);
		expect(snapshot.storefrontAccessRules.find((row) => row.type === 'LIST').emailListId).toBe(list._id);
		expect(snapshot.emailListEntries.map((row) => row.email).sort()).toEqual(['a@x.vn', 'b@x.vn']);
		expect(snapshot.products.find((row) => row._id === product._id).storefrontId).toBe(club._id);
		expect(snapshot.combos.find((row) => row._id === combo._id).storefrontIds).toEqual([DEFAULT_STOREFRONT_ID, club._id].sort());
		expect(snapshot.orders.find((row) => row._id === order._id).storefrontId).toBe(club._id);
		expect(snapshot.orders.filter((row) => row.isDirectSale).every((row) => !('storefrontId' in row))).toBe(true);
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
		expect(problemsOf(snapshot)).toEqual([]);
		expect(buildMetadata(snapshot, new Date()).collections).toMatchObject({ storefronts: 2, storefrontAccessRules: 3, emailLists: 1, emailListEntries: 2 });
	});

	it('restores to itself and drops what the file does not hold, access included', async () => {
		const { club } = await seedStorefronts();
		const first = await dataSnapshot.exportAll();
		await data.emailLists.create({ name: 'Intruder' });
		await data.storefronts.create({ slug: 'intruder', name: 'Intruder' });
		await data.storefronts.addRule({ storefrontId: club._id, type: 'EMAIL', value: 'intruder@x.vn' });

		const written = await restore(first);

		expect(written).toMatchObject({ storefronts: 2, storefrontAccessRules: 3, emailLists: 1, emailListEntries: 2, combos: 1, orders: 2 });
		expect(await dataSnapshot.exportAll()).toEqual(first);
		expect(await data.storefronts.viewerCanAccess(club._id, 'B@X.vn')).toBe(true);
		expect(await data.storefronts.viewerCanAccess(club._id, 'intruder@x.vn')).toBe(false);
		expect(await data.storefronts.findBySlug('intruder')).toBeNull();
	});

	it('restores a file whose storefront has orders, products and combo links', async () => {
		const { club, product, combo, order } = await seedStorefronts();
		const first = await dataSnapshot.exportAll();
		await prisma.$executeRaw`TRUNCATE storefronts, products, orders, combos, email_lists RESTART IDENTITY CASCADE`;

		await restore(first);

		expect((await data.products.findById(product._id)).storefrontId).toBe(club._id);
		expect((await data.combos.findById(combo._id)).storefrontIds).toEqual([DEFAULT_STOREFRONT_ID, club._id].sort());
		expect((await data.orders.findById(order._id)).storefrontId).toBe(club._id);
		await expect(data.storefronts.remove(club._id)).rejects.toMatchObject({ code: 'STOREFRONT_IN_USE' });
	});

	describe('a file with storefronts but without the default one', () => {
		const withoutDefault = (snapshot, clubId) => {
			const file = clone(snapshot);
			const move = (id) => (id === DEFAULT_STOREFRONT_ID ? clubId : id);
			file.storefronts = file.storefronts.filter((row) => row._id !== DEFAULT_STOREFRONT_ID);
			file.products.forEach((row) => { row.storefrontId = move(row.storefrontId); });
			file.combos.forEach((row) => { row.storefrontIds = [...new Set(row.storefrontIds.map(move))]; });
			file.orders.forEach((row) => { if (row.storefrontId) row.storefrontId = move(row.storefrontId); });
			return file;
		};

		it('restores the default storefront as an inactive public one, so the foreign-key fallback still works', async () => {
			const { club } = await seedStorefronts();
			const file = withoutDefault(await dataSnapshot.exportAll(), club._id);
			expect(problemsOf(file)).toEqual([]);

			const written = await restore(file);

			expect(written.storefronts).toBe(2);
			const stored = await data.storefronts.findById(DEFAULT_STOREFRONT_ID);
			expect(stored).toMatchObject({ slug: 'cua-hang', visibility: 'PUBLIC', isActive: false, sortOrder: club.sortOrder + 1 });
			expect((await data.storefronts.listActive()).map((row) => row._id)).toEqual([club._id]);
		});

		it('gives the recreated default storefront a free slug when a storefront of the file holds its own', async () => {
			const { club } = await seedStorefronts();
			const file = withoutDefault(await dataSnapshot.exportAll(), club._id);
			file.storefronts.find((row) => row._id === club._id).slug = 'cua-hang';

			await restore(file);

			expect((await data.storefronts.findById(DEFAULT_STOREFRONT_ID)).slug).toBe('cua-hang-2');
			expect((await data.storefronts.findById(club._id)).slug).toBe('cua-hang');
		});
	});

	describe('a file made before storefronts existed', () => {
		const legacyOf = (snapshot) => {
			const legacy = clone(snapshot);
			for (const section of STOREFRONT_SECTIONS) delete legacy[section];
			legacy.products.forEach((row) => delete row.storefrontId);
			legacy.combos.forEach((row) => delete row.storefrontIds);
			legacy.orders.forEach((row) => delete row.storefrontId);
			return legacy;
		};

		it('is a valid file, and puts everything in the recreated default storefront', async () => {
			await seedStorefronts();
			const legacy = legacyOf(await dataSnapshot.exportAll());
			expect(problemsOf(legacy)).toEqual([]);
			await prisma.$executeRaw`TRUNCATE storefronts, products, orders, combos, email_lists RESTART IDENTITY CASCADE`;

			const written = await restore(legacy);

			expect(written).toMatchObject({ storefronts: 1, storefrontAccessRules: 0, emailLists: 0, emailListEntries: 0 });
			const after = await dataSnapshot.exportAll();
			expect(after.storefronts).toEqual([expect.objectContaining({ _id: DEFAULT_STOREFRONT_ID, slug: 'cua-hang', visibility: 'PUBLIC', isActive: true })]);
			expect(after.products.every((row) => row.storefrontId === DEFAULT_STOREFRONT_ID)).toBe(true);
			expect(after.combos.every((row) => row.storefrontIds.length === 1 && row.storefrontIds[0] === DEFAULT_STOREFRONT_ID)).toBe(true);
			expect(after.orders.filter((row) => !row.isDirectSale).every((row) => row.storefrontId === DEFAULT_STOREFRONT_ID)).toBe(true);
			expect(after.orders.filter((row) => row.isDirectSale).every((row) => !('storefrontId' in row))).toBe(true);
			expect(problemsOf(after)).toEqual([]);
		});

		it('treats a null storefront field like an absent one when the storefront sections are missing', async () => {
			await seedStorefronts();
			const legacy = legacyOf(await dataSnapshot.exportAll());
			legacy.products[0].storefrontId = null;
			legacy.combos[0].storefrontIds = null;

			expect(problemsOf(legacy)).toEqual([]);
			legacy.products[0].storefrontId = DEFAULT_STOREFRONT_ID;
			expect(problemsOf(legacy).join('\n')).toContain('cần đi cùng các phần');
		});

		it('replaces the storefronts of the running store, which the file does not know', async () => {
			await seedStorefronts();
			const legacy = legacyOf(await dataSnapshot.exportAll());

			await restore(legacy);

			expect((await data.storefronts.listAll()).map((row) => row._id)).toEqual([DEFAULT_STOREFRONT_ID]);
			expect(await prisma.storefrontAccessRule.count()).toBe(0);
			expect(await prisma.emailListEntry.count()).toBe(0);
		});
	});

	describe('a forged file', () => {
		let valid;

		beforeEach(async () => {
			await seedStorefronts();
			valid = clone(await dataSnapshot.exportAll());
		});

		const ruleOf = (file, type) => file.storefrontAccessRules.find((row) => row.type === type);

		it.each([
			['a product in a storefront the file does not hold', (file) => { file.products[0].storefrontId = '01a173f3-7280-71fd-b24f-000000000001'; }, 'products[0].storefrontId trỏ tới cửa hàng không có trong file'],
			['a product without a storefront', (file) => { delete file.products[0].storefrontId; }, 'thiếu "storefrontId"'],
			['an order in a storefront the file does not hold', (file) => { file.orders.find((row) => !row.isDirectSale).storefrontId = '01a173f3-7280-71fd-b24f-000000000001'; }, 'cửa hàng không có trong file'],
			['a combo linked to no storefront', (file) => { file.combos[0].storefrontIds = []; }, 'phải có ít nhất một cửa hàng'],
			['a combo linked twice to one storefront', (file) => { file.combos[0].storefrontIds = [DEFAULT_STOREFRONT_ID, DEFAULT_STOREFRONT_ID]; }, 'cửa hàng bị lặp'],
			['a rule for a storefront the file does not hold', (file) => { ruleOf(file, 'EMAIL').storefrontId = '01a173f3-7280-71fd-b24f-000000000001'; }, 'storefrontId trỏ tới cửa hàng không có trong file'],
			['a LIST rule for a list the file does not hold', (file) => { ruleOf(file, 'LIST').emailListId = '01a173f3-7280-71fd-b24f-000000000001'; }, 'danh sách email không có trong file'],
			['a LIST rule without a list', (file) => { delete ruleOf(file, 'LIST').emailListId; }, 'thiếu "emailListId"'],
			['an EMAIL rule that names a list', (file) => { ruleOf(file, 'EMAIL').emailListId = file.emailLists[0]._id; }, 'không dùng "emailListId"'],
			['an EMAIL rule with an upper case address', (file) => { ruleOf(file, 'EMAIL').value = 'One@Gmail.com'; }, 'value phải là chuỗi chữ thường'],
			['a DOMAIN rule that is not a domain', (file) => { ruleOf(file, 'DOMAIN').value = '@sab'; }, 'không phải tên miền hợp lệ'],
			['a repeated rule', (file) => { file.storefrontAccessRules.push({ ...ruleOf(file, 'EMAIL'), _id: '01a173f3-7280-71fd-b24f-000000000002' }); }, 'bị trùng quy tắc'],
			['an entry for a list the file does not hold', (file) => { file.emailListEntries[0].emailListId = '01a173f3-7280-71fd-b24f-000000000001'; }, 'danh sách email không có trong file'],
			['an upper case list entry', (file) => { file.emailListEntries[0].email = 'A@X.vn'; }, 'phải là email chữ thường hợp lệ'],
			['a repeated list entry', (file) => { file.emailListEntries.push({ ...file.emailListEntries[0], _id: '01a173f3-7280-71fd-b24f-000000000003' }); }, 'bị trùng email'],
			['two storefronts with one slug', (file) => { file.storefronts[1].slug = file.storefronts[0].slug; }, 'slug bị trùng trong file'],
			['a slug that breaks the rule', (file) => { file.storefronts[0].slug = 'Bad Slug'; }, 'đường dẫn hợp lệ'],
			['a storefront with an unknown field', (file) => { file.storefronts[0].owner = 'x'; }, 'trường "owner" không được nhận diện'],
			['no active storefront', (file) => { file.storefronts.forEach((row) => { row.isActive = false; }); }, 'ít nhất một cửa hàng đang hoạt động'],
			['no storefront at all', (file) => { file.storefronts = []; file.storefrontAccessRules = []; file.products = []; file.combos = []; file.orders = []; }, 'ít nhất một cửa hàng đang hoạt động'],
			['a visibility the database does not have', (file) => { file.storefronts[0].visibility = 'SECRET'; }, 'phải là một trong: PUBLIC, PRIVATE'],
			['only some of the storefront sections', (file) => { delete file.emailLists; }, 'phải đi cùng nhau'],
			['storefront fields without the sections', (file) => { for (const section of STOREFRONT_SECTIONS) delete file[section]; }, 'cần đi cùng các phần']
		])('refuses %s', (_label, forge, expected) => {
			const file = clone(valid);
			forge(file);

			const problems = problemsOf(file);

			expect(problems.length).toBeGreaterThan(0);
			expect(problems.join('\n')).toContain(expected);
		});

		it('refuses a count in the metadata that disagrees with a storefront section', () => {
			const metadata = buildMetadata(valid, new Date());
			metadata.collections.emailListEntries += 1;

			expect(validateSnapshot(metadata, valid).join('\n')).toContain('metadata.collections.emailListEntries');
		});

		it('leaves the store as it was when the database refuses what validation cannot see', async () => {
			const before = await dataSnapshot.exportAll();
			const dangling = clone(valid);
			ruleOf(dangling, 'EMAIL').storefrontId = '01a173f3-7280-71fd-b24f-000000000001';
			const upper = clone(valid);
			upper.emailListEntries[0].email = 'UPPER@X.VN';
			const slugClash = clone(valid);
			slugClash.storefronts[1].slug = slugClash.storefronts[0].slug;

			await expect(restore(dangling)).rejects.toMatchObject({ code: 'REFERENCE_VIOLATION' });
			await expect(restore(upper)).rejects.toMatchObject({ name: 'RecordValidationError' });
			await expect(restore(slugClash)).rejects.toMatchObject({ name: 'DuplicateKeyError' });

			expect(await dataSnapshot.exportAll()).toEqual(before);
		});
	});
});
