/**
 * What a visitor can learn about a PRIVATE storefront from every public read
 * endpoint: nothing, unless an access rule admits their verified email (or they
 * are staff previewing). The server is the real app; only data is seeded.
 */
const request = require('supertest');
const { POSTGRES } = require('../helpers/backend');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeOrder, createAccount, signInSession, makeAdminSession, makeSellerSession } = require('../helpers/factories');
const { setUserColumns } = require('../auth/auth-test-kit');
const { DEFAULT_STOREFRONT_ID } = require('../../data/default-storefront');
const { ogVersion, toPublicProduct } = require('../../services/public-catalog');

const PRIVATE_PRODUCT = 'Secret Plush';
const PRIVATE_COMBO = 'Secret Bundle';
const HIDDEN_SAME_CATEGORY = 'Hidden Open Plush';
const PRIVATE_PRICE = 987654;
const PRIVATE_COMBO_PRICE = 765432;
const PRIVATE_IMAGE = 'https://img.test/secret-plush.jpg';
// Names, prices and pictures of private items; the storefront's own name is shown on purpose.
const COUNTER_ONLY_PRODUCT = 'Counter Only Secret';
const MIN_ORDER_PRODUCT = 'Min Order Secret';
const SECRETS = [
	PRIVATE_PRODUCT, PRIVATE_COMBO, HIDDEN_SAME_CATEGORY, COUNTER_ONLY_PRODUCT, MIN_ORDER_PRODUCT,
	String(PRIVATE_PRICE), String(PRIVATE_COMBO_PRICE), 'secret-plush.jpg'
];
// What a 401/403 may say: the code, a message and the storefront's slug and name, nothing else.
const ACCESS_ERROR_KEYS = ['code', 'message', 'storefront', 'success'];

const textOf = (res) => (res.text !== undefined && res.text !== '' ? res.text : JSON.stringify(res.body ?? {}));
const expectNoSecrets = (res) => {
	for (const secret of SECRETS) expect(textOf(res)).not.toContain(secret);
};

describe.skipIf(!POSTGRES)('private storefront leak', () => {
	let app;
	let data;
	let priv;
	let openProduct;
	let privProduct;
	let openCombo;
	let privCombo;
	let openSlug;

	const get = (url, cookies) => {
		const req = request(app).get(url);
		return cookies ? req.set('Cookie', cookies) : req;
	};
	const catalogUrl = () => `/api/storefronts/${priv.slug}/catalog`;

	async function customer({ verified = true, whitelisted = false } = {}) {
		const account = await createAccount({ prefix: 'cust' });
		await setUserColumns(account.email, { emailVerified: verified });
		const cookies = await signInSession(app, account);
		let rule = null;
		if (whitelisted) rule = await data.storefronts.addRule({ storefrontId: priv._id, type: 'EMAIL', value: account.email });
		return { ...account, cookies, rule };
	}

	beforeEach(async () => {
		app = buildTestApp();
		data = require('../../data');
		openSlug = (await data.storefronts.findById(DEFAULT_STOREFRONT_ID)).slug;
		priv = await data.storefronts.create({ slug: 'private-shop', name: 'Private Shop', visibility: 'PRIVATE' });

		openProduct = await makeProduct({ name: 'Open Plush', price: 111111, category: 'open-cat', imageUrl: 'https://img.test/open.jpg', salesChannel: 'online' });
		privProduct = await makeProduct({
			name: PRIVATE_PRODUCT, price: PRIVATE_PRICE, category: 'secret-cat', imageUrl: PRIVATE_IMAGE, salesChannel: 'online', storefrontId: priv._id
		});
		// Same category as the open product, other storefront: must not show up in an open combo's lists.
		await makeProduct({ name: HIDDEN_SAME_CATEGORY, price: PRIVATE_PRICE, category: 'open-cat', salesChannel: 'online', storefrontId: priv._id });
		openCombo = await makeCombo({ name: 'Open Bundle', price: 100000, categoryRequirements: [{ category: 'open-cat', quantity: 1 }] });
		privCombo = await makeCombo({
			name: PRIVATE_COMBO, price: PRIVATE_COMBO_PRICE, categoryRequirements: [{ category: 'secret-cat', quantity: 1 }], storefrontIds: [priv._id]
		});
	});

	describe('anonymous visitor', () => {
		const sweep = () => [
			['product list', () => get('/api/products'), 200],
			['product list, searched', () => get('/api/products').query({ search: 'Secret' }), 200],
			['product list, private category', () => get('/api/products').query({ category: 'secret-cat' }), 200],
			['categories', () => get('/api/products/categories/list'), 200],
			['active combos', () => get('/api/combos/active'), 200],
			['active combos, counter channel', () => get('/api/combos/active').query({ channel: 'offline' }), 200],
			['product by code', () => get(`/api/products/by-code/${privProduct.publicCode}`), 401],
			['product by code, lower case', () => get(`/api/products/by-code/${privProduct.publicCode.toLowerCase()}`), 401],
			['product by id', () => get(`/api/products/${privProduct._id}`), 401],
			['combo by code', () => get(`/api/combos/by-code/${privCombo.publicCode}`), 401],
			['pricing of a private product', () => request(app).post('/api/combos/pricing').send({ items: [{ productId: privProduct._id, quantity: 1 }] }), 401],
			['storefront list', () => get('/api/storefronts'), 200],
			['private catalog', () => get(catalogUrl()), 401],
			['share image, combo', () => get(`/api/share/image/c/${privCombo.publicCode}.jpg`).query({ v: 'deadbeef' }), 404],
			['share meta, product', () => get('/api/share/meta').query({ type: 'p', code: privProduct.publicCode }), 404],
			['share meta, combo', () => get('/api/share/meta').query({ type: 'c', code: privCombo.publicCode }), 404],
			['share image, product, current version', () => get(`/api/share/image/p/${privProduct.publicCode}.jpg`).query({ v: ogVersion(toPublicProduct(privProduct)) }), 404],
			['settings', () => get('/api/settings'), 200]
		];

		it.each(sweep())('%s reveals no private item', async (_label, call, status) => {
			const res = await call();

			expect(res.status).toBe(status);
			expectNoSecrets(res);
			if (status === 401 || status === 403) expect(Object.keys(res.body).sort()).toEqual(ACCESS_ERROR_KEYS);
		});

		it('still serves the open storefront', async () => {
			const list = await get('/api/products');
			expect(list.body.data.products.map((product) => product.name)).toEqual(['Open Plush']);
			expect(list.body.data.categories).toEqual(['open-cat']);

			const categories = await get('/api/products/categories/list');
			expect(categories.body.data).toEqual(['open-cat']);

			const combos = await get('/api/combos/active');
			expect(combos.body.data.combos.map((combo) => combo.name)).toEqual(['Open Bundle']);
			expect(combos.body.data.combos[0]).not.toHaveProperty('storefrontIds');

			const byCode = await get(`/api/products/by-code/${openProduct.publicCode}`);
			expect(byCode.status).toBe(200);
			expect(byCode.headers['cache-control']).toBe('public, max-age=60');

			const catalog = await get(`/api/storefronts/${openSlug}/catalog`);
			expect(catalog.status).toBe(200);
			expect(catalog.body.data).toMatchObject({ canOrder: true, total: 1 });
		});

		it('asks to sign in, naming only the storefront', async () => {
			const res = await get(`/api/products/by-code/${privProduct.publicCode}`);

			expect(res.status).toBe(401);
			expect(res.body).toMatchObject({ success: false, code: 'STOREFRONT_LOGIN_REQUIRED', storefront: { slug: 'private-shop', name: 'Private Shop' } });
			expect(Object.keys(res.body).sort()).toEqual(['code', 'message', 'storefront', 'success']);
		});

		it('lists the private storefront as locked and the open one as accessible', async () => {
			const res = await get('/api/storefronts');

			expect(res.headers['cache-control']).toBe('private, no-store');
			const byId = Object.fromEntries(res.body.data.storefronts.map((storefront) => [storefront.slug, storefront]));
			expect(byId['private-shop']).toMatchObject({ visibility: 'PRIVATE', locked: true, accessible: false, canOrder: false });
			expect(byId[openSlug]).toMatchObject({ visibility: 'PUBLIC', locked: false, accessible: true, canOrder: true });
		});

		it('does not list a private product in an open combo, nor its category', async () => {
			const res = await get(`/api/combos/by-code/${openCombo.publicCode}`);

			expect(res.status).toBe(200);
			const names = res.body.data.requirements.flatMap((requirement) => requirement.products.map((product) => product.name));
			expect(names).toEqual(['Open Plush']);
			expectNoSecrets(res);
		});

		it('asks for sign-in before it says anything about a cart that mixes in a private storefront', async () => {
			const res = await request(app).post('/api/combos/pricing').send({
				items: [{ productId: openProduct._id, quantity: 1 }, { productId: privProduct._id, quantity: 1 }]
			});

			expect(res.status).toBe(401);
			expect(res.body.code).toBe('STOREFRONT_LOGIN_REQUIRED');
			expectNoSecrets(res);
		});

		it('exposes the sign-in options and nothing of the mail account on settings', async () => {
			const res = await get('/api/settings');

			expect(typeof res.body.data.otpAvailable).toBe('boolean');
			expect(res.body.data).toHaveProperty('googleClientId');
			for (const key of ['host', 'password', 'user', 'smtp']) expect(res.body.data).not.toHaveProperty(key);
		});

		it('serves a combo linked to an open and a private storefront as open, without the private products', async () => {
			const shared = await makeCombo({
				name: 'Shared Bundle', price: 90000, categoryRequirements: [{ category: 'open-cat', quantity: 1 }], storefrontIds: [DEFAULT_STOREFRONT_ID, priv._id]
			});

			const byCode = await get(`/api/combos/by-code/${shared.publicCode}`);
			const active = await get('/api/combos/active');
			const meta = await get('/api/share/meta').query({ type: 'c', code: shared.publicCode });

			expect(byCode.status).toBe(200);
			expect(byCode.headers['cache-control']).toBe('private, no-store');
			expect(active.body.data.combos.map((combo) => combo.name)).toContain('Shared Bundle');
			expect(meta.status).toBe(200);
			for (const res of [byCode, active, meta]) expectNoSecrets(res);
		});
	});

	describe('cart errors never come before the access check', () => {
		let counterOnly;
		let minOrder;

		const orderBody = (items, expectedTotal) => ({
			studentId: '24120001',
			fullName: 'Nguyen Van A',
			email: 'buyer@example.com',
			phoneNumber: '0987654321',
			additionalNote: '',
			items,
			expectedTotal
		});
		const placeOrder = (items, expectedTotal, cookies) => {
			const req = request(app).post('/api/orders');
			return (cookies ? req.set('Cookie', cookies) : req).send(orderBody(items, expectedTotal));
		};
		const preview = (items, cookies, extra = {}) => {
			const req = request(app).post('/api/combos/pricing');
			return (cookies ? req.set('Cookie', cookies) : req).send({ items, ...extra });
		};

		beforeEach(async () => {
			// Pricing would name these in its errors: a counter-only product on the web, and one below its minimum.
			counterOnly = await makeProduct({
				name: COUNTER_ONLY_PRODUCT, price: PRIVATE_PRICE, category: 'secret-cat', salesChannel: 'offline', storefrontId: priv._id
			});
			minOrder = await makeProduct({
				name: MIN_ORDER_PRODUCT, price: PRIVATE_PRICE, category: 'secret-cat', salesChannel: 'online', minOrderQuantity: 5, storefrontId: priv._id
			});
		});

		// Each cart would make pricing answer with a name, a minimum or a total if it ran first.
		const carts = () => [
			['a wrong expected total', [{ productId: privProduct._id, quantity: 1 }], 0],
			['a product sold at the counter only', [{ productId: counterOnly._id, quantity: 1 }], PRIVATE_PRICE],
			['a quantity below the minimum', [{ productId: minOrder._id, quantity: 1 }], PRIVATE_PRICE]
		];

		it.each([
			['an anonymous visitor', null, 401, 'STOREFRONT_LOGIN_REQUIRED'],
			['a verified email no rule admits', { verified: true, whitelisted: false }, 403, 'STOREFRONT_ORDER_FORBIDDEN']
		])('POST /api/orders by %s answers the access error alone', async (_label, who, status, code) => {
			const cookies = who ? (await customer(who)).cookies : undefined;

			for (const [, items, expectedTotal] of carts()) {
				const res = await placeOrder(items, expectedTotal, cookies);

				expect(res.status).toBe(status);
				expect(res.body.code).toBe(code);
				expect(Object.keys(res.body).sort()).toEqual(ACCESS_ERROR_KEYS);
				expectNoSecrets(res);
			}
		});

		it.each([
			['an anonymous visitor', null, 401],
			['a verified email no rule admits', { verified: true, whitelisted: false }, 403]
		])('POST /api/combos/pricing by %s answers the access error alone', async (_label, who, status) => {
			const cookies = who ? (await customer(who)).cookies : undefined;

			for (const [, items] of carts()) {
				const res = await preview(items, cookies);

				expect(res.status).toBe(status);
				expect(Object.keys(res.body).sort()).toEqual(ACCESS_ERROR_KEYS);
				expectNoSecrets(res);
			}
			const counter = await preview(carts()[1][1], cookies, { channel: 'offline' });
			expect(counter.status).toBe(status);
			expectNoSecrets(counter);
		});

		it('a quantity of zero reveals nothing either', async () => {
			const items = [{ productId: privProduct._id, quantity: 0 }];

			for (const res of [await preview(items), await placeOrder(items, 0)]) {
				expect(res.status).toBe(400);
				expectNoSecrets(res);
			}
		});

		it('an admitted customer still gets the pricing detail of their own storefront', async () => {
			const member = await customer({ whitelisted: true });

			const res = await placeOrder([{ productId: privProduct._id, quantity: 1 }], 0, member.cookies);

			expect(res.status).toBe(409);
			expect(res.body.code).toBe('PRICE_CHANGED');
		});
	});

	describe('order tracking by code', () => {
		it('serves a private storefront\'s order to whoever holds its code, and nothing else of the storefront', async () => {
			// Accepted: the order code is the credential, like for any other order; the
			// response is the same fixed field set and carries no storefront data.
			const order = await makeOrder({
				storefrontId: priv._id,
				items: [{ productId: privProduct._id, productName: PRIVATE_PRODUCT, price: PRIVATE_PRICE, quantity: 1 }],
				totalAmount: PRIVATE_PRICE
			});

			const res = await get(`/api/orders/${order.orderCode}`);

			expect(res.status).toBe(200);
			const allowed = ['orderCode', 'status', 'totalAmount', 'createdAt', 'statusUpdatedAt', 'qrUrl', 'paymentDescription', 'items'];
			for (const key of Object.keys(res.body.data)) expect(allowed).toContain(key);
			expect(res.body.data.items).toEqual([{ productName: PRIVATE_PRODUCT, quantity: 1, price: PRIVATE_PRICE }]);
			for (const hidden of ['private-shop', 'Private Shop', String(priv._id), 'storefront', order.email]) {
				expect(textOf(res)).not.toContain(hidden);
			}
		});
	});

	describe('signed-in customer', () => {
		it('sees and may order from a private storefront that admits their email', async () => {
			const member = await customer({ whitelisted: true });

			const catalog = await get(catalogUrl(), member.cookies);
			expect(catalog.status).toBe(200);
			expect(catalog.headers['cache-control']).toBe('private, no-store');
			expect(catalog.body.data).toMatchObject({ canOrder: true, total: 2, storefront: { slug: 'private-shop' } });
			const names = catalog.body.data.products.map((product) => product.name).sort();
			expect(names).toEqual([HIDDEN_SAME_CATEGORY, PRIVATE_PRODUCT].sort());
			expect(catalog.body.data.combos.map((combo) => combo.name)).toEqual([PRIVATE_COMBO]);
			expect(catalog.body.data.combos[0]).not.toHaveProperty('storefrontIds');
			for (const product of catalog.body.data.products) {
				for (const key of ['stockQuantity', 'sku', 'isActive', 'inStock']) expect(product).not.toHaveProperty(key);
			}

			const byCode = await get(`/api/products/by-code/${privProduct.publicCode}`, member.cookies);
			expect(byCode.status).toBe(200);
			expect(byCode.headers['cache-control']).toBe('private, no-store');
			expect((await get(`/api/products/${privProduct._id}`, member.cookies)).status).toBe(200);
			expect((await get(`/api/combos/by-code/${privCombo.publicCode}`, member.cookies)).status).toBe(200);

			const list = await get('/api/storefronts', member.cookies);
			expect(list.body.data.storefronts.find((storefront) => storefront.slug === 'private-shop'))
				.toMatchObject({ locked: false, accessible: true, canOrder: true });
		});

		it('prices a private cart for an admitted email only', async () => {
			const member = await customer({ whitelisted: true });
			const stranger = await customer();
			const body = { items: [{ productId: privProduct._id, quantity: 1 }] };

			const allowed = await request(app).post('/api/combos/pricing').set('Cookie', member.cookies).send(body);
			const refused = await request(app).post('/api/combos/pricing').set('Cookie', stranger.cookies).send(body);

			expect(allowed.status).toBe(200);
			// The private combo applies to this cart on its own, so the admitted customer is charged its price.
			expect(allowed.body.data.totalAmount).toBe(PRIVATE_COMBO_PRICE);
			expect(refused.status).toBe(403);
			expectNoSecrets(refused);
		});

		it('keeps the private catalog out of the open endpoints even when admitted', async () => {
			const member = await customer({ whitelisted: true });

			const list = await get('/api/products', member.cookies);
			const combos = await get('/api/combos/active', member.cookies);

			expect(list.body.data.products.map((product) => product.name)).toEqual(['Open Plush']);
			expect(combos.body.data.combos.map((combo) => combo.name)).toEqual(['Open Bundle']);
		});

		it.each([
			['a verified email no rule admits', { verified: true, whitelisted: false }],
			['an admitted email that is not verified', { verified: false, whitelisted: true }]
		])('is refused with %s', async (_label, options) => {
			const visitor = await customer(options);

			const responses = await Promise.all([
				get(catalogUrl(), visitor.cookies),
				get(`/api/products/by-code/${privProduct.publicCode}`, visitor.cookies),
				get(`/api/products/${privProduct._id}`, visitor.cookies),
				get(`/api/combos/by-code/${privCombo.publicCode}`, visitor.cookies),
				get('/api/share/meta', visitor.cookies).query({ type: 'p', code: privProduct.publicCode })
			]);

			expect(responses.map((res) => res.status)).toEqual([403, 403, 403, 403, 404]);
			expect(responses[0].body).toMatchObject({ code: 'STOREFRONT_FORBIDDEN', storefront: { slug: 'private-shop' } });
			for (const res of responses) expectNoSecrets(res);
			for (const res of responses.filter((response) => response.status === 403)) {
				expect(Object.keys(res.body).sort()).toEqual(ACCESS_ERROR_KEYS);
			}

			const list = await get('/api/storefronts', visitor.cookies);
			expect(list.body.data.storefronts.find((storefront) => storefront.slug === 'private-shop'))
				.toMatchObject({ locked: true, accessible: false, canOrder: false });
		});

		it('loses access on the very next request once the rule is removed', async () => {
			const member = await customer({ whitelisted: true });
			expect((await get(catalogUrl(), member.cookies)).status).toBe(200);

			await data.storefronts.removeRule(priv._id, member.rule._id);

			const after = await get(catalogUrl(), member.cookies);
			expect(after.status).toBe(403);
			expectNoSecrets(after);
		});

		it('is admitted by a domain rule', async () => {
			const visitor = await customer();
			await data.storefronts.addRule({ storefrontId: priv._id, type: 'DOMAIN', value: visitor.email.split('@')[1] });

			expect((await get(catalogUrl(), visitor.cookies)).status).toBe(200);
		});

		it('is admitted by an email list rule', async () => {
			const visitor = await customer();
			const list = await data.emailLists.create({ name: 'Lop A' });
			await data.emailLists.addEntries(list._id, [visitor.email]);
			await data.storefronts.addRule({ storefrontId: priv._id, type: 'LIST', emailListId: list._id });

			expect((await get(catalogUrl(), visitor.cookies)).status).toBe(200);
		});
	});

	describe('staff', () => {
		it.each([
			['admin', makeAdminSession],
			['seller', makeSellerSession]
		])('previews the private catalog as %s but may not order unless admitted', async (_role, makeSession) => {
			const staff = await makeSession(app);

			const preview = await get(catalogUrl(), staff.cookies);
			expect(preview.status).toBe(200);
			expect(preview.body.data.canOrder).toBe(false);
			expect((await get(`/api/products/by-code/${privProduct.publicCode}`, staff.cookies)).status).toBe(200);

			const list = await get('/api/storefronts', staff.cookies);
			expect(list.body.data.storefronts.find((storefront) => storefront.slug === 'private-shop'))
				.toMatchObject({ locked: false, accessible: true, canOrder: false });

			// Admitted by address: the verified email now counts, like any customer's.
			await setUserColumns(staff.email, { emailVerified: true });
			await data.storefronts.addRule({ storefrontId: priv._id, type: 'EMAIL', value: staff.email });
			const admitted = await get(catalogUrl(), await signInSession(app, staff));
			expect(admitted.body.data.canOrder).toBe(true);
		});
	});

	describe('inactive storefront', () => {
		it('is absent for everyone but staff', async () => {
			const member = await customer({ whitelisted: true });
			await data.storefronts.update(priv._id, { isActive: false });
			const admin = await makeAdminSession(app);

			const anonymous = await get(catalogUrl());
			const admitted = await get(catalogUrl(), member.cookies);
			const preview = await get(catalogUrl(), admin.cookies);
			const list = await get('/api/storefronts');

			expect(anonymous.status).toBe(404);
			expect(anonymous.body.code).toBe('STOREFRONT_NOT_FOUND');
			expect(anonymous.body).not.toHaveProperty('storefront');
			expect(admitted.status).toBe(404);
			expect(preview.status).toBe(200);
			expect(preview.body.data.canOrder).toBe(false);
			expect(list.body.data.storefronts.map((storefront) => storefront.slug)).not.toContain('private-shop');
		});

		it('answers 404 for an unknown slug', async () => {
			const res = await get('/api/storefronts/no-such-shop/catalog');

			expect(res.status).toBe(404);
			expect(res.body.code).toBe('STOREFRONT_NOT_FOUND');
		});
	});

	describe('share previews', () => {
		it('still render for an open product and combo', async () => {
			const product = await get('/api/share/meta').query({ type: 'p', code: openProduct.publicCode });
			const combo = await get('/api/share/meta').query({ type: 'c', code: openCombo.publicCode });

			expect(product.status).toBe(200);
			expect(combo.status).toBe(200);
			expect(product.text).toContain('Open Plush');
		});

		it('refuse the image of a private combo, even at its current version', async () => {
			const { findPublicByType } = require('../../services/og-meta');
			expect(await findPublicByType('c', privCombo.publicCode)).toBeNull();

			const res = await get(`/api/share/image/c/${privCombo.publicCode}.jpg`).query({ v: 'deadbeef' });
			expect(res.status).toBe(404);
		});
	});
});
