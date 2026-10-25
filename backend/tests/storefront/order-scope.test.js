/**
 * Which storefront an order belongs to and who may place it: the private order
 * matrix on POST /api/orders, the pricing scope (mixed carts, combos linked to
 * other storefronts), counter sales across storefronts and order edits.
 * Storefronts exist on Postgres only.
 */
const request = require('supertest');
const { POSTGRES } = require('../helpers/backend');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeOrder, createAccount, signInSession, makeSellerSession, makeAdminSession } = require('../helpers/factories');
const { countRows } = require('../helpers/db');
const { uniqueEmail, sendCode, signInWithCode, captureMail, codeOf, setUserColumns } = require('../auth/auth-test-kit');

describe.skipIf(!POSTGRES)('storefront order scope', () => {
	let app;
	let data;
	let computeOrderPricing;
	let sent;
	let counter = 0;

	beforeAll(() => {
		app = buildTestApp();
		data = require('../../data');
		({ computeOrderPricing } = require('../../services/pricing'));
	});

	beforeEach(() => {
		sent = captureMail();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const storefront = (visibility = 'PUBLIC') => {
		counter += 1;
		return data.storefronts.create({ slug: `scope-${counter}`, name: `Scope ${counter}`, visibility });
	};
	const privateStorefront = () => storefront('PRIVATE');
	const admit = (shop, email) => data.storefronts.addRule({ storefrontId: shop._id, type: 'EMAIL', value: email });

	// One category per test file run keeps the default "general" combos of other
	// fixtures out of the way; the category is unique per call.
	const product = (shop, overrides = {}) => makeProduct({ storefrontId: shop._id, price: 100000, stockQuantity: 0, ...overrides });
	const line = (p, quantity = 1) => ({ productId: String(p._id), quantity });
	const onlineTotal = async (items, scope) => (await computeOrderPricing(items, { channel: 'online', scope })).totalAmount;

	// The order's email rule accepts a 2-3 letter top-level domain only.
	async function customerSession(email = uniqueEmail().replace('@test.local', '@test.vn')) {
		await sendCode(app, email);
		const res = await signInWithCode(app, email, codeOf(sent.at(-1)));
		expect(res.status).toBe(200);
		return { email, cookies: res.headers['set-cookie'] };
	}

	const body = (items, expectedTotal, overrides = {}) => ({
		studentId: '24120001',
		fullName: 'Nguyen Van A',
		email: 'typed-by-client@example.com',
		phoneNumber: '0987654321',
		additionalNote: '',
		items,
		expectedTotal,
		...overrides
	});

	async function placeOrder(items, { cookies, expectedTotal, ...overrides } = {}) {
		const total = expectedTotal ?? await onlineTotal(items);
		const req = request(app).post('/api/orders');
		return (cookies ? req.set('Cookie', cookies) : req).send(body(items, total, overrides));
	}

	describe('POST /api/orders on a private storefront', () => {
		it('accepts a whitelisted customer and stores the session email, not the typed one', async () => {
			const shop = await privateStorefront();
			const buyer = await customerSession();
			await admit(shop, buyer.email);
			const item = await product(shop);

			const res = await placeOrder([line(item)], { cookies: buyer.cookies });

			expect(res.status).toBe(201);
			const stored = await data.orders.findByCode(res.body.data.orderCode);
			expect(stored.email).toBe(buyer.email);
			expect(String(stored.storefrontId)).toBe(String(shop._id));
		});

		it('refuses a customer no rule admits and creates nothing', async () => {
			const shop = await privateStorefront();
			const buyer = await customerSession();
			const item = await product(shop);

			const res = await placeOrder([line(item)], { cookies: buyer.cookies });

			expect(res.status).toBe(403);
			expect(res.body.code).toBe('STOREFRONT_ORDER_FORBIDDEN');
			expect(res.body.storefront).toEqual({ slug: shop.slug, name: shop.name });
			expect(await countRows('order')).toBe(0);
		});

		it('asks an anonymous visitor to sign in', async () => {
			const shop = await privateStorefront();
			const item = await product(shop);

			const res = await placeOrder([line(item)]);

			expect(res.status).toBe(401);
			expect(res.body.code).toBe('STOREFRONT_LOGIN_REQUIRED');
			expect(await countRows('order')).toBe(0);
		});

		it.each([
			['an admin', makeAdminSession],
			['a seller', makeSellerSession]
		])('refuses %s outside the whitelist', async (_label, makeSession) => {
			const shop = await privateStorefront();
			const staff = await makeSession(app);
			const item = await product(shop);

			const res = await placeOrder([line(item)], { cookies: staff.cookies });

			expect(res.status).toBe(403);
			expect(res.body.code).toBe('STOREFRONT_ORDER_FORBIDDEN');
		});

		it('accepts a staff account whose verified email is whitelisted', async () => {
			const shop = await privateStorefront();
			const seller = await createAccount({ role: 'seller', prefix: 'seller', domain: 'test.vn' });
			await setUserColumns(seller.email, { emailVerified: true });
			await admit(shop, seller.email);
			const cookies = await signInSession(app, seller);
			const item = await product(shop);

			const res = await placeOrder([line(item)], { cookies });

			expect(res.status).toBe(201);
			expect((await data.orders.findByCode(res.body.data.orderCode)).email).toBe(seller.email);
		});

		it('blocks the very next order once the email is revoked', async () => {
			const shop = await privateStorefront();
			const buyer = await customerSession();
			const rule = await admit(shop, buyer.email);
			const item = await product(shop);
			expect((await placeOrder([line(item)], { cookies: buyer.cookies })).status).toBe(201);

			await data.storefronts.removeRule(shop._id, rule._id);
			const res = await placeOrder([line(item)], { cookies: buyer.cookies });

			expect(res.status).toBe(403);
			expect(res.body.code).toBe('STOREFRONT_ORDER_FORBIDDEN');
			expect(await countRows('order')).toBe(1);
		});

		it('refuses an inactive storefront', async () => {
			const shop = await storefront();
			const item = await product(shop);
			await data.storefronts.update(shop._id, { isActive: false });

			const res = await placeOrder([line(item)]);

			expect(res.status).toBe(404);
			expect(res.body.code).toBe('STOREFRONT_NOT_FOUND');
		});
	});

	describe('POST /api/orders on a public storefront', () => {
		it('needs no session and keeps the email the customer typed', async () => {
			const shop = await storefront();
			const item = await product(shop);

			const res = await placeOrder([line(item)]);

			expect(res.status).toBe(201);
			const stored = await data.orders.findByCode(res.body.data.orderCode);
			expect(stored.email).toBe('typed-by-client@example.com');
			expect(String(stored.storefrontId)).toBe(String(shop._id));
		});
	});

	describe('mixed carts', () => {
		it('refuses an online order spanning two storefronts', async () => {
			const [a, b] = [await storefront(), await storefront()];
			const items = [line(await product(a)), line(await product(b))];

			const res = await placeOrder(items, { expectedTotal: 200000 });

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('ORDER_MIXED_STOREFRONTS');
			expect(await countRows('order')).toBe(0);
		});

		it('fails closed when the caller names no scope', async () => {
			const [a, b] = [await storefront(), await storefront()];
			const items = [line(await product(a)), line(await product(b))];

			await expect(computeOrderPricing(items, { channel: 'online' })).rejects.toMatchObject({ code: 'ORDER_MIXED_STOREFRONTS' });
			await expect(computeOrderPricing(items, { channel: 'online', scope: 'oops' })).rejects.toBeInstanceOf(TypeError);
		});
	});

	describe('combos', () => {
		const requirement = (category) => [{ category, quantity: 2 }];

		it('never applies a combo linked to another storefront', async () => {
			const [a, b] = [await storefront(), await storefront()];
			const category = `cat-${counter}`;
			await makeCombo({ price: 150000, categoryRequirements: requirement(category), storefrontIds: [b._id] });
			const items = [line(await product(a, { category }), 2)];

			const priced = await computeOrderPricing(items, { channel: 'online', scope: 'single' });

			expect(priced.totalAmount).toBe(200000);
			expect(priced.comboInfo).toBeNull();
			expect(String(priced.storefrontId)).toBe(String(a._id));
		});

		it('applies a combo linked to two storefronts in both', async () => {
			const [a, b] = [await storefront(), await storefront()];
			const category = `cat-${counter}`;
			await makeCombo({ price: 150000, categoryRequirements: requirement(category), storefrontIds: [a._id, b._id] });

			for (const shop of [a, b]) {
				const priced = await computeOrderPricing([line(await product(shop, { category }), 2)], { channel: 'online', scope: 'single' });
				expect(priced.totalAmount).toBe(150000);
				expect(priced.comboInfo.combos).toHaveLength(1);
			}
		});

		it('counts only the lines of the combo\'s own storefronts in a mixed counter cart', async () => {
			const [a, b, c] = [await storefront(), await storefront(), await storefront()];
			const category = `cat-${counter}`;
			await makeCombo({ price: 150000, categoryRequirements: requirement(category), storefrontIds: [a._id, b._id] });
			const covered = [line(await product(a, { category })), line(await product(b, { category }))];
			const foreign = [line(await product(a, { category })), line(await product(c, { category }))];

			const together = await computeOrderPricing(covered, { channel: 'offline', scope: 'any' });
			const apart = await computeOrderPricing(foreign, { channel: 'offline', scope: 'any' });

			expect(together.totalAmount).toBe(150000);
			expect(together.storefrontId).toBeNull();
			expect(apart.totalAmount).toBe(200000);
		});

		it('prices a single-storefront cart under the unrestricted scope like the scoped one', async () => {
			const shop = await storefront();
			const category = `cat-${counter}`;
			await makeCombo({ price: 150000, categoryRequirements: requirement(category), storefrontIds: [shop._id] });
			const items = [line(await product(shop, { category }), 2)];

			const any = await computeOrderPricing(items, { channel: 'online', scope: 'any' });
			const scoped = await computeOrderPricing(items, { channel: 'online', scope: { storefrontId: shop._id } });

			expect(any.totalAmount).toBe(150000);
			expect(scoped.totalAmount).toBe(150000);
			expect(String(any.storefrontId)).toBe(String(shop._id));
		});

		it('refuses a product of another storefront when pricing inside one', async () => {
			const [a, b] = [await storefront(), await storefront()];
			const items = [line(await product(b))];

			await expect(computeOrderPricing(items, { channel: 'online', scope: { storefrontId: a._id } }))
				.rejects.toMatchObject({ code: 'ORDER_MIXED_STOREFRONTS' });
		});
	});

	describe('POST /api/seller/orders/direct', () => {
		const sell = (cookies, items, expectedTotal) =>
			request(app).post('/api/seller/orders/direct').set('Cookie', cookies).send({ items, expectedTotal });

		it('sells private items without any whitelist check and records the storefront', async () => {
			const shop = await privateStorefront();
			const { cookies } = await makeSellerSession(app);
			const item = await product(shop);

			const res = await sell(cookies, [line(item)], 100000);

			expect(res.status).toBe(201);
			expect(String((await data.orders.findByCode(res.body.data.orderCode)).storefrontId)).toBe(String(shop._id));
		});

		it('sells a cart spanning storefronts and leaves the order without one', async () => {
			const [a, b] = [await privateStorefront(), await storefront()];
			const { cookies } = await makeSellerSession(app);
			const items = [line(await product(a)), line(await product(b))];

			const res = await sell(cookies, items, 200000);

			expect(res.status).toBe(201);
			expect((await data.orders.findByCode(res.body.data.orderCode)).storefrontId ?? null).toBeNull();
		});

		it('is previewed for a seller at the total the sale then charges', async () => {
			const [a, b] = [await privateStorefront(), await storefront()];
			const category = `cat-${counter}`;
			await makeCombo({ price: 150000, categoryRequirements: [{ category, quantity: 2 }], storefrontIds: [a._id, b._id] });
			const items = [line(await product(a, { category })), line(await product(b, { category }))];
			const { cookies } = await makeSellerSession(app);

			const preview = await request(app).post('/api/combos/pricing').set('Cookie', cookies).send({ items, channel: 'offline' });
			expect(preview.status).toBe(200);
			expect(preview.body.data.totalAmount).toBe(150000);

			const sale = await sell(cookies, items, preview.body.data.totalAmount);
			expect(sale.status).toBe(201);
			expect((await data.orders.findByCode(sale.body.data.orderCode)).totalAmount).toBe(preview.body.data.totalAmount);
		});

		it('is previewed as one storefront\'s cart for anyone who is not staff', async () => {
			const [a, b] = [await storefront(), await storefront()];
			const items = [line(await product(a)), line(await product(b))];

			const anonymous = await request(app).post('/api/combos/pricing').send({ items, channel: 'offline' });
			const customer = await customerSession();
			const signedIn = await request(app).post('/api/combos/pricing').set('Cookie', customer.cookies).send({ items, channel: 'offline' });

			for (const res of [anonymous, signedIn]) {
				expect(res.status).toBe(400);
				expect(res.body.code).toBe('ORDER_MIXED_STOREFRONTS');
			}
		});
	});

	describe('order edits keep the stored total', () => {
		let admin;

		beforeEach(async () => {
			admin = await makeAdminSession(app);
		});

		const edit = (order, items) =>
			request(app).put(`/api/admin/orders/${order._id}/items`).set('Cookie', admin.cookies).send({ expectedRevision: 0, reason: 'Đổi hàng', items });

		const orderOf = (items, fields = {}) =>
			makeOrder({
				items: items.map((p) => ({ productId: p._id, productName: p.name, price: p.price, quantity: 1 })),
				totalAmount: items.reduce((sum, p) => sum + p.price, 0),
				...fields
			});

		it('swaps inside the order\'s storefront', async () => {
			const shop = await storefront();
			const [from, to] = [await product(shop), await product(shop)];
			const order = await orderOf([from], { storefrontId: shop._id });

			const res = await edit(order, [line(to)]);

			expect(res.status).toBe(200);
			expect((await data.orders.findById(order._id)).totalAmount).toBe(100000);
		});

		it('refuses a product of another storefront on an online order', async () => {
			const [a, b] = [await storefront(), await storefront()];
			const from = await product(a);
			const order = await orderOf([from], { storefrontId: a._id });

			const res = await edit(order, [line(await product(b))]);

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('ORDER_MIXED_STOREFRONTS');
			expect((await data.orders.findById(order._id)).itemsRevision ?? 0).toBe(0);
		});

		it('edits a mixed counter sale across storefronts', async () => {
			const [a, b] = [await storefront(), await storefront()];
			const order = await orderOf([await product(a), await product(b)], { isDirectSale: true, storefrontId: null });

			const res = await edit(order, [line(await product(b)), line(await product(a))]);

			expect(res.status).toBe(200);
		});

		it('edits a legacy order that has no storefront', async () => {
			const [a, b] = [await storefront(), await storefront()];
			const order = await orderOf([await product(a)], { isDirectSale: true, storefrontId: null });
			const to = await product(b);

			const res = await edit(order, [line(to)]);

			expect(res.status).toBe(200);
			const stored = await data.orders.findById(order._id);
			expect(stored.totalAmount).toBe(100000);
			expect(stored.items.map((item) => String(item.productId))).toEqual([String(to._id)]);
			expect(stored.storefrontId ?? null).toBeNull();
		});
	});
});
