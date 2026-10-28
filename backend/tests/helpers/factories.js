/**
 * Test data factories.
 *
 * `makeProduct`, `makeCombo` and `makeOrder` go through the repositories, whose
 * validation and column defaults keep the fixtures honest with what production
 * can write, and return the repository's plain record (`_id` a uuid string).
 * `makeSettings` and the legacy factories are the exception: they exist to
 * store shapes the repositories would never write.
 */
const { randomUUID } = require('crypto');
const request = require('supertest');
const data = require('../../data');
const { DEFAULT_STOREFRONT_ID } = require('../../data/default-storefront');
const { insertRawProduct, insertRawSettings, patchProduct, patchCombo, patchOrder } = require('./db');

// A caller may choose the timestamps of a new row (a backdated order); a
// repository stamps rows itself, so the fixture sets them afterwards.
const STAMPS = ['createdAt', 'updatedAt'];

async function createStamped(create, patch, find, fields) {
	const stamps = Object.fromEntries(STAMPS.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]));
	const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => !(key in stamps)));
	const created = await create(rest);
	if (Object.keys(stamps).length === 0) return created;
	await patch(created._id, stamps);
	return find(created._id);
}

let sequence = 0;
function nextSequence() {
	sequence += 1;
	return sequence;
}

/**
 * Creates a product. Defaults describe a normal, purchasable item so a test
 * only has to override the one or two fields it cares about.
 */
async function makeProduct(overrides = {}) {
	const n = nextSequence();
	const fields = {
		name: `Test Product ${n}`,
		description: 'Factory-created product',
		price: 100000,
		category: 'general',
		available: true,
		stockQuantity: 10,
		...overrides,
	};
	// The repository takes the opening balance apart from the fields and writes it
	// to the cache without a movement: the fixture is stock-neutral.
	const { stockQuantity, ...rest } = fields;
	rest.storefrontId ??= DEFAULT_STOREFRONT_ID;
	return createStamped((own) => data.products.create(own, stockQuantity), patchProduct, data.products.findById, rest);
}

/**
 * Creates a combo. Defaults require 2 units of the "general" category, the
 * same category makeProduct() defaults to, so `[makeProduct(), makeProduct()]`
 * plus a default combo already satisfies the requirement.
 */
async function makeCombo(overrides = {}) {
	const n = nextSequence();
	const fields = {
		name: `Test Combo ${n}`,
		description: 'Factory-created combo',
		price: 150000,
		categoryRequirements: [{ category: 'general', quantity: 2 }],
		isActive: true,
		...overrides,
	};
	fields.storefrontIds ??= [DEFAULT_STOREFRONT_ID];
	return createStamped(data.combos.create, patchCombo, data.combos.findById, fields);
}

/**
 * Creates a confirmed web order for two units of a fresh product, with the
 * stock already taken (`stockDeducted`) the way a placed order has it. The
 * fixture is stock-neutral: it records no movement and leaves the product's
 * cached stock untouched. When the caller passes `items`, no product is
 * created and `totalAmount` defaults to 0, so a test that counts products is
 * not disturbed.
 */
async function makeOrder(overrides = {}) {
	let lines = { totalAmount: 0 };
	if (!overrides.items) {
		const product = await makeProduct({ stockQuantity: 10 });
		lines = {
			items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 2 }],
			totalAmount: product.price * 2,
		};
	}
	const n = Math.floor(Math.random() * 1e8); // 8 digits max: "W" + 8 digits = 9 chars, under the 10-char orderCode limit
	const fields = {
		orderCode: `W${n}`,
		studentId: `SV${n}`,
		fullName: 'Web Buyer',
		email: `buyer${n}@test.vn`, // TLD must be 2-3 chars per the schema's email regex
		phoneNumber: '0912345678',
		...lines,
		status: 'confirmed',
		isDirectSale: false,
		stockDeducted: true,
		statusHistory: [{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date() }],
		...overrides,
	};
	if (!fields.isDirectSale) fields.storefrontId ??= DEFAULT_STOREFRONT_ID;
	return createStamped((own) => data.orders.create(own), patchOrder, (id) => data.orders.findById(id), fields);
}

/**
 * Creates the settings row with exactly the given fields: a field left out is
 * stored as missing (NULL on SQL) and the application applies its default, and
 * `''` is stored as the deliberate "hidden" choice. Goes through the raw insert
 * so no schema default fills in either case.
 */
const makeSettings = (fields) => insertRawSettings(fields);

/**
 * A product the way one written before public codes existed looks: inserted
 * through db.js's raw insert, so there is no `publicCode`.
 */

function makeLegacyProduct(overrides = {}) {
	const n = nextSequence();
	return insertRawProduct({
		name: `Legacy Product ${n}`,
		price: 100000,
		category: 'general',
		available: true,
		stockQuantity: 10,
		...overrides,
	});
}

const TEST_PASSWORD = 'factory-test-password-1';

/**
 * Creates an account the way the app does: public sign-up is disabled, so
 * accounts come from the server-side admin API (init-database seeding uses the
 * same call) with the role set at creation.
 */
async function createAccount({ role, prefix = 'user', password = TEST_PASSWORD, domain = 'test.local' } = {}) {
	const n = nextSequence();
	const email = `${prefix}-${n}-${randomUUID()}@${domain}`;
	const username = `${prefix}_${n}_${randomUUID().slice(0, 8)}`;
	// Loaded on use: pulling lib/auth in at import time would load the app's
	// dependency graph before a test that spies on a module the routes destructure.
	const { auth } = require('../../lib/auth');
	await auth.api.createUser({
		body: { email, password, name: `${prefix} ${n}`, ...(role ? { role } : {}), data: { username } },
	});
	return { email, password, username };
}

async function signInSession(app, { email, password }) {
	const res = await request(app).post('/api/auth/sign-in/email').send({ email, password });
	if (res.status !== 200) {
		throw new Error(`sign-in failed with ${res.status}: ${JSON.stringify(res.body)}`);
	}
	const cookies = res.headers['set-cookie'];
	if (!cookies || cookies.length === 0) {
		throw new Error('sign-in did not return a session cookie');
	}
	return cookies;
}

/** An admin account plus a signed-in session cookie, through the real auth handler. */
async function makeAdminSession(app) {
	const account = await createAccount({ role: 'admin', prefix: 'admin' });
	return { ...account, cookies: await signInSession(app, account) };
}

/** A seller account plus a signed-in session cookie. */
async function makeSellerSession(app) {
	const account = await createAccount({ role: 'seller', prefix: 'seller' });
	return { ...account, cookies: await signInSession(app, account) };
}

module.exports = {
	makeProduct, makeCombo, makeOrder, makeSettings, makeLegacyProduct,
	createAccount, signInSession, makeAdminSession, makeSellerSession,
};
