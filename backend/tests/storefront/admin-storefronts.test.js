const request = require('supertest');
const ExcelJS = require('exceljs');
const { randomUUID } = require('crypto');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeSellerSession, makeProduct, makeOrder } = require('../helpers/factories');
const { uniqueEmail, sendCode, signInWithCode, captureMail, codeOf } = require('../auth/auth-test-kit');
const { DEFAULT_STOREFRONT_ID } = require('../../data/default-storefront');

function bufferParser(res, cb) {
	const chunks = [];
	res.on('data', (chunk) => chunks.push(chunk));
	res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('admin storefront API', () => {
	let app;
	let cookies;
	let counter = 0;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		({ cookies } = await makeAdminSession(app));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const as = (method, path, jar = cookies) => request(app)[method](`/api/admin${path}`).set('Cookie', jar);
	const shopBody = (fields = {}) => {
		counter += 1;
		return { slug: `shop-${counter}`, name: `Shop ${counter}`, visibility: 'PUBLIC', isActive: true, ...fields };
	};
	const makeShop = async (fields) => (await as('post', '/storefronts').send(shopBody(fields))).body.data;

	describe('who may call it', () => {
		it('answers 401 without a session, 403 to a seller and 403 to a customer, and creates nothing', async () => {
			const seller = await makeSellerSession(app);
			const sent = captureMail();
			const email = uniqueEmail();
			await sendCode(app, email);
			const signedIn = await signInWithCode(app, email, codeOf(sent.at(-1)));
			const customerCookies = signedIn.headers['set-cookie'];

			const anonymous = await request(app).post('/api/admin/storefronts').send(shopBody());
			const asSeller = await as('post', '/storefronts', seller.cookies).send(shopBody());
			const asCustomer = await as('post', '/storefronts', customerCookies).send(shopBody());
			const listAsCustomer = await as('get', '/email-lists', customerCookies);

			expect(anonymous.status).toBe(401);
			expect(asSeller.status).toBe(403);
			expect(asCustomer.status).toBe(403);
			expect(listAsCustomer.status).toBe(403);
			expect((await as('get', '/storefronts')).body.data).toHaveLength(1);
		});
	});

	describe('storefronts', () => {
		it('lists the default storefront and creates one at the end of the display order', async () => {
			const created = await as('post', '/storefronts').send(shopBody({ name: '  Cửa hàng A  ', description: ' Mô tả ' }));

			expect(created.status).toBe(201);
			expect(created.body.data).toMatchObject({ name: 'Cửa hàng A', description: 'Mô tả', visibility: 'PUBLIC', isActive: true });
			const list = await as('get', '/storefronts');
			expect(list.body.data.map((shop) => shop._id)).toEqual([DEFAULT_STOREFRONT_ID, created.body.data._id]);
		});

		it('refuses a bad body with the schema errors and a taken slug with STOREFRONT_SLUG_TAKEN', async () => {
			const bad = await as('post', '/storefronts').send(shopBody({ slug: 'Bad Slug', visibility: 'SECRET' }));
			const first = await makeShop({ slug: 'taken' });
			const taken = await as('post', '/storefronts').send(shopBody({ slug: 'taken' }));

			expect(first.slug).toBe('taken');
			expect(bad.status).toBe(400);
			expect(bad.body.errors.map((entry) => entry.field).sort()).toEqual(['slug', 'visibility']);
			expect(taken.status).toBe(409);
			expect(taken.body).toMatchObject({ success: false, code: 'STOREFRONT_SLUG_TAKEN' });
		});

		it('updates the given fields only, clears a description with null and renames onto a taken slug as 409', async () => {
			const shop = await makeShop({ description: 'Cũ' });
			const other = await makeShop();

			const renamed = await as('put', `/storefronts/${shop._id}`).send({ name: 'Tên mới', visibility: 'PRIVATE' });
			const cleared = await as('put', `/storefronts/${shop._id}`).send({ description: null });
			const clash = await as('put', `/storefronts/${shop._id}`).send({ slug: other.slug });

			expect(renamed.body.data).toMatchObject({ name: 'Tên mới', visibility: 'PRIVATE', description: 'Cũ', slug: shop.slug });
			expect(cleared.body.data).not.toHaveProperty('description');
			expect(clash.status).toBe(409);
			expect(clash.body.code).toBe('STOREFRONT_SLUG_TAKEN');
		});

		it('does not take sortOrder or an unknown key from the body', async () => {
			const shop = await makeShop();

			const res = await as('put', `/storefronts/${shop._id}`).send({ name: 'Giữ', sortOrder: 99, _id: randomUUID() });

			expect(res.body.data).toMatchObject({ _id: shop._id, sortOrder: shop.sortOrder });
		});

		it('answers 404 for an unknown storefront, 400 for a malformed id and 400 for an empty update', async () => {
			const shop = await makeShop();

			const unknown = await as('put', `/storefronts/${randomUUID()}`).send({ name: 'x' });
			const malformed = await as('put', '/storefronts/not-an-id').send({ name: 'x' });
			const empty = await as('put', `/storefronts/${shop._id}`).send({});

			expect(unknown.status).toBe(404);
			expect(unknown.body.code).toBe('STOREFRONT_NOT_FOUND');
			expect(malformed.status).toBe(400);
			expect(empty.status).toBe(400);
		});

		it('refuses to deactivate the last active storefront and allows it once another is active', async () => {
			const refused = await as('put', `/storefronts/${DEFAULT_STOREFRONT_ID}`).send({ isActive: false });
			const other = await makeShop();
			const allowed = await as('put', `/storefronts/${DEFAULT_STOREFRONT_ID}`).send({ isActive: false });
			const lastAgain = await as('put', `/storefronts/${other._id}`).send({ isActive: false });

			expect(refused.status).toBe(409);
			expect(refused.body.code).toBe('LAST_ACTIVE_STOREFRONT');
			expect(allowed.status).toBe(200);
			expect(allowed.body.data.isActive).toBe(false);
			expect(lastAgain.body.code).toBe('LAST_ACTIVE_STOREFRONT');
		});

		it('reorders, leaving a request that is not a clean id list untouched', async () => {
			const a = await makeShop();
			const b = await makeShop();
			const ids = [b._id, DEFAULT_STOREFRONT_ID, a._id];

			const ok = await as('put', '/storefronts/reorder').send({ ids });
			const repeated = await as('put', '/storefronts/reorder').send({ ids: [a._id, a._id] });
			const unknown = await as('put', '/storefronts/reorder').send({ ids: [randomUUID()] });
			const empty = await as('put', '/storefronts/reorder').send({ ids: [] });

			expect(ok.status).toBe(200);
			expect(ok.body.data.map((shop) => shop._id)).toEqual(ids);
			expect(repeated.status).toBe(400);
			expect(unknown.status).toBe(400);
			expect(empty.status).toBe(400);
			expect((await as('get', '/storefronts')).body.data.map((shop) => shop._id)).toEqual(ids);
		});

		describe('delete', () => {
			it('removes an unused storefront and answers 404 for it afterwards', async () => {
				const shop = await makeShop();

				const first = await as('delete', `/storefronts/${shop._id}`);
				const second = await as('delete', `/storefronts/${shop._id}`);

				expect(first.status).toBe(200);
				expect(second.status).toBe(404);
				expect((await as('get', '/storefronts')).body.data).toHaveLength(1);
			});

			it('refuses the default storefront', async () => {
				await makeShop();

				const res = await as('delete', `/storefronts/${DEFAULT_STOREFRONT_ID}`);

				expect(res.status).toBe(409);
				expect(res.body.code).toBe('DEFAULT_STOREFRONT');
			});

			it('refuses a storefront that products or orders still use, with the counts', async () => {
				const shop = await makeShop();
				await makeProduct({ storefrontId: shop._id });
				await makeOrder({ storefrontId: shop._id });

				const res = await as('delete', `/storefronts/${shop._id}`);

				expect(res.status).toBe(409);
				expect(res.body.code).toBe('STOREFRONT_IN_USE');
				expect(res.body.details).toMatchObject({ products: 1, orders: 1 });
				expect((await as('get', '/storefronts')).body.data).toHaveLength(2);
			});

			it('refuses the last active storefront', async () => {
				const shop = await makeShop();
				await as('put', `/storefronts/${DEFAULT_STOREFRONT_ID}`).send({ isActive: false });

				const res = await as('delete', `/storefronts/${shop._id}`);

				expect(res.status).toBe(409);
				expect(res.body.code).toBe('LAST_ACTIVE_STOREFRONT');
			});
		});
	});

	describe('access rules', () => {
		let shop;

		beforeEach(async () => {
			shop = await makeShop({ visibility: 'PRIVATE' });
		});

		const addRule = (body, id = shop._id) => as('post', `/storefronts/${id}/rules`).send(body);
		const makeList = async (name = 'Lop A') => (await as('post', '/email-lists').send({ name })).body.data;

		it('stores an EMAIL value and a DOMAIN value lowercased and trimmed, and records who added it', async () => {
			const email = await addRule({ type: 'EMAIL', value: '  Student@Gmail.COM ' });
			const domain = await addRule({ type: 'DOMAIN', value: ' SAB.edu.vn ' });

			expect(email.status).toBe(201);
			expect(email.body.data).toMatchObject({ type: 'EMAIL', value: 'student@gmail.com', createdBy: expect.any(String) });
			expect(domain.body.data).toMatchObject({ type: 'DOMAIN', value: 'sab.edu.vn' });
			const listed = await as('get', `/storefronts/${shop._id}/rules`);
			expect(listed.body.data.map((rule) => rule.value)).toEqual(['student@gmail.com', 'sab.edu.vn']);
		});

		it('adds a LIST rule that reports the list name and entry count', async () => {
			const list = await makeList();
			await as('post', `/email-lists/${list._id}/entries`).send({ emails: ['a@gmail.com', 'b@gmail.com'] });

			const res = await addRule({ type: 'LIST', emailListId: list._id });

			expect(res.status).toBe(201);
			const [rule] = (await as('get', `/storefronts/${shop._id}/rules`)).body.data;
			expect(rule).toMatchObject({ type: 'LIST', emailListId: list._id, emailListName: 'Lop A', entryCount: 2 });
		});

		it('answers 409 ACCESS_RULE_DUPLICATE for the same EMAIL, DOMAIN or LIST again, whatever the case', async () => {
			const list = await makeList();
			await addRule({ type: 'EMAIL', value: 'a@gmail.com' });
			await addRule({ type: 'DOMAIN', value: 'sab.edu.vn' });
			await addRule({ type: 'LIST', emailListId: list._id });

			const responses = await Promise.all([
				addRule({ type: 'EMAIL', value: ' A@GMAIL.com' }),
				addRule({ type: 'DOMAIN', value: 'SAB.EDU.VN' }),
				addRule({ type: 'LIST', emailListId: list._id })
			]);

			for (const res of responses) {
				expect(res.status).toBe(409);
				expect(res.body.code).toBe('ACCESS_RULE_DUPLICATE');
			}
			expect((await as('get', `/storefronts/${shop._id}/rules`)).body.data).toHaveLength(3);
		});

		it('lets two storefronts hold the same rule', async () => {
			const other = await makeShop({ visibility: 'PRIVATE' });
			await addRule({ type: 'DOMAIN', value: 'sab.edu.vn' });

			const res = await addRule({ type: 'DOMAIN', value: 'sab.edu.vn' }, other._id);

			expect(res.status).toBe(201);
		});

		it('refuses a LIST rule for a list that does not exist, and an unknown storefront', async () => {
			const noList = await addRule({ type: 'LIST', emailListId: randomUUID() });
			const noShop = await addRule({ type: 'DOMAIN', value: 'sab.edu.vn' }, randomUUID());
			const listing = await as('get', `/storefronts/${randomUUID()}/rules`);

			expect(noList.status).toBe(404);
			expect(noList.body.code).toBe('EMAIL_LIST_NOT_FOUND');
			expect(noShop.status).toBe(404);
			expect(noShop.body.code).toBe('STOREFRONT_NOT_FOUND');
			expect(listing.status).toBe(404);
			expect((await as('get', `/storefronts/${shop._id}/rules`)).body.data).toEqual([]);
		});

		it.each([
			['an unknown type', { type: 'REGEX', value: '.*' }],
			['an EMAIL that is not an address', { type: 'EMAIL', value: 'sab.edu.vn' }],
			['a DOMAIN with a single label', { type: 'DOMAIN', value: 'edu' }],
			['a DOMAIN written as an address', { type: 'DOMAIN', value: 'a@sab.edu.vn' }],
			['a LIST without a list', { type: 'LIST' }],
			['a LIST with a malformed list id', { type: 'LIST', emailListId: 'nope' }],
			['nothing', {}]
		])('answers 400 for %s', async (_label, body) => {
			const res = await addRule(body);

			expect(res.status).toBe(400);
			expect(res.body.errors.length).toBeGreaterThan(0);
		});

		it('removes a rule once, and only through its own storefront', async () => {
			const other = await makeShop({ visibility: 'PRIVATE' });
			const { body } = await addRule({ type: 'DOMAIN', value: 'sab.edu.vn' });
			const ruleId = body.data._id;

			const wrongShop = await as('delete', `/storefronts/${other._id}/rules/${ruleId}`);
			const removed = await as('delete', `/storefronts/${shop._id}/rules/${ruleId}`);
			const again = await as('delete', `/storefronts/${shop._id}/rules/${ruleId}`);

			expect(wrongShop.status).toBe(404);
			expect(removed.status).toBe(200);
			expect(again.status).toBe(404);
			expect((await as('get', `/storefronts/${shop._id}/rules`)).body.data).toEqual([]);
		});

		it('drops the LIST rules of a deleted email list', async () => {
			const list = await makeList();
			await addRule({ type: 'LIST', emailListId: list._id });

			await as('delete', `/email-lists/${list._id}`);

			expect((await as('get', `/storefronts/${shop._id}/rules`)).body.data).toEqual([]);
		});
	});

	describe('products and orders carry the storefront', () => {
		const productBody = (fields = {}) => ({ name: 'Bánh', price: 15000, category: 'food', ...fields });

		it('creates a product in the named storefront and in the default one when none is named', async () => {
			const shop = await makeShop();

			const named = await as('post', '/products').send(productBody({ storefrontId: shop._id }));
			const unnamed = await as('post', '/products').send(productBody());

			expect(named.status).toBe(201);
			expect(named.body.data.product.storefrontId).toBe(shop._id);
			expect(unnamed.body.data.product.storefrontId).toBe(DEFAULT_STOREFRONT_ID);
		});

		it('refuses a storefront that does not exist, on create and on update, with STOREFRONT_NOT_FOUND', async () => {
			const product = await makeProduct();

			const created = await as('post', '/products').send(productBody({ storefrontId: randomUUID() }));
			const updated = await as('put', `/products/${product._id}`).send({ storefrontId: randomUUID() });

			for (const res of [created, updated]) {
				expect(res.status).toBe(404);
				expect(res.body.code).toBe('STOREFRONT_NOT_FOUND');
			}
		});

		it.each([['an id that is not an id', 'nope'], ['null', null]])('refuses %s on create and on update as invalid data', async (_label, bad) => {
			const product = await makeProduct();

			const created = await as('post', '/products').send(productBody({ storefrontId: bad }));
			const updated = await as('put', `/products/${product._id}`).send({ storefrontId: bad });

			for (const res of [created, updated]) {
				expect(res.status).toBe(400);
				expect(res.body.errors[0].field).toBe('storefrontId');
			}
		});

		it('moves a product to another storefront and leaves it alone when the update names none', async () => {
			const shop = await makeShop();
			const product = await makeProduct();

			const moved = await as('put', `/products/${product._id}`).send({ storefrontId: shop._id });
			const renamed = await as('put', `/products/${product._id}`).send({ name: 'Đổi tên' });

			expect(moved.body.data.product.storefrontId).toBe(shop._id);
			expect(renamed.body.data.product.storefrontId).toBe(shop._id);
		});

		it('filters the admin product list by storefront, rejects a malformed id and finds nothing for an unknown one', async () => {
			const shop = await makeShop();
			const inShop = await makeProduct({ storefrontId: shop._id });
			await makeProduct();

			const filtered = await as('get', '/products').query({ storefrontId: shop._id });
			const all = await as('get', '/products');
			const malformed = await as('get', '/products').query({ storefrontId: 'nope' });
			const unknown = await as('get', '/products').query({ storefrontId: randomUUID() });

			expect(filtered.body.data.map((product) => product._id)).toEqual([inShop._id]);
			expect(all.body.meta.total).toBe(2);
			expect(malformed.status).toBe(400);
			expect(unknown.body.meta.total).toBe(0);
		});

		it('filters the order list by storefront and shows the storefront on each order', async () => {
			const shop = await makeShop();
			await makeOrder({ storefrontId: shop._id });
			await makeOrder({ storefrontId: shop._id });
			await makeOrder();

			const filtered = await as('get', '/orders').query({ storefrontId: shop._id });
			const all = await as('get', '/orders');
			const malformed = await as('get', '/orders').query({ storefrontId: 'nope' });
			const unknown = await as('get', '/orders').query({ storefrontId: randomUUID() });

			expect(filtered.body.meta.total).toBe(2);
			expect(filtered.body.data.every((order) => order.storefrontId === shop._id)).toBe(true);
			expect(all.body.meta.total).toBe(3);
			expect(malformed.status).toBe(400);
			expect(unknown.body.meta.total).toBe(0);
		});

		it('puts the storefront name in the order export, quoting a name that looks like a formula, and filters by storefront', async () => {
			const shop = await makeShop({ name: '=Cua hang' });
			await makeOrder({ orderCode: 'EXPSHOP1', storefrontId: shop._id });
			await makeOrder({ orderCode: 'EXPDEF1' });

			const load = async (query) => {
				const res = await as('get', '/orders/export/excel').query(query).buffer(true).parse(bufferParser);
				const workbook = new ExcelJS.Workbook();
				await workbook.xlsx.load(res.body);
				return workbook.getWorksheet('Đơn hàng');
			};
			const everything = await load({});
			const onlyShop = await load({ storefrontId: shop._id });

			// The storefront column is the last (N); the name starts like a formula, so it is quoted.
			expect(everything.getRow(1).getCell('N').value).toBe('Gian hàng');
			const names = [2, 3].map((row) => String(everything.getRow(row).getCell('N').value));
			expect(names).toContain("'=Cua hang");
			expect(onlyShop.rowCount).toBe(2);
			expect(String(onlyShop.getRow(2).getCell('A').value)).toBe('EXPSHOP1');
		});
	});
});
