/**
 * Test data factories.
 *
 * Every factory writes through the real Mongoose model instead of inserting a
 * plain object, so factory output stays honest with schema defaults,
 * validation and indexes — a factory that drifts from the schema would let a
 * test pass against a document production code could never actually produce.
 */
const { randomUUID } = require('crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const { insertRawProduct, insertRawCombo } = require('./db');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const Order = require('../../models/Order');
const Settings = require('../../models/Settings');

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
	return Product.create({
		name: `Test Product ${n}`,
		description: 'Factory-created product',
		price: 100000,
		category: 'general',
		available: true,
		stockQuantity: 10,
		...overrides,
	});
}

/**
 * Creates a combo. Defaults require 2 units of the "general" category, the
 * same category makeProduct() defaults to, so `[makeProduct(), makeProduct()]`
 * plus a default combo already satisfies the requirement.
 */
async function makeCombo(overrides = {}) {
	const n = nextSequence();
	return Combo.create({
		name: `Test Combo ${n}`,
		description: 'Factory-created combo',
		price: 150000,
		categoryRequirements: [{ category: 'general', quantity: 2 }],
		isActive: true,
		...overrides,
	});
}

/**
 * Creates a confirmed web order for two units of a fresh product, with the
 * stock already taken (`stockDeducted`) the way a placed order has it. The
 * fixture is stock-neutral: it records no movement and leaves the product's
 * cached stock untouched. When the caller passes `items`, no product is
 * created and `totalAmount` defaults to 0, so a test that counts products is
 * not disturbed. Like the other factories it returns a Mongoose document,
 * unlike the plain objects of helpers/db.js.
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
	return Order.create({
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
	});
}

/**
 * Creates the settings row. The caller supplies the required payment fields
 * (`bankNameId`, `bankAccountId`); the key and every other field take their
 * schema defaults.
 */
const makeSettings = (fields) => Settings.create(fields);

/**
 * A document the way one written before public codes existed looks: inserted
 * through db.js's raw insert, so no hook runs and there is no `publicCode`.
 * Returns the stored document with its native ObjectId `_id`, which the
 * legacy tests pass to the raw driver.
 */
const asStored = (row) => ({ ...row, _id: new mongoose.Types.ObjectId(row._id) });

function makeLegacyProduct(overrides = {}) {
	const n = nextSequence();
	return insertRawProduct({
		name: `Legacy Product ${n}`,
		price: 100000,
		category: 'general',
		available: true,
		stockQuantity: 10,
		...overrides,
	}).then(asStored);
}

function makeLegacyCombo(overrides = {}) {
	const n = nextSequence();
	return insertRawCombo({
		name: `Legacy Combo ${n}`,
		price: 150000,
		categoryRequirements: [{ category: 'general', quantity: 2 }],
		isActive: true,
		...overrides,
	}).then(asStored);
}

const TEST_PASSWORD = 'factory-test-password-1';

/**
 * Creates an account the way the app does: public sign-up is disabled, so
 * accounts come from the server-side admin API (init-database seeding uses the
 * same call) with the role set at creation.
 */
async function createAccount({ role, prefix = 'user', password = TEST_PASSWORD } = {}) {
	const n = nextSequence();
	const email = `${prefix}-${n}-${randomUUID()}@test.local`;
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
	makeProduct, makeCombo, makeOrder, makeSettings, makeLegacyProduct, makeLegacyCombo,
	createAccount, makeAdminSession, makeSellerSession,
};
