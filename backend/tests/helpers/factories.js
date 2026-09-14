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
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const User = require('../../models/User');

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
		isActive: true,
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
 * Signs up a real user through better-auth on the app under test, then
 * promotes it to admin directly in Mongo, and signs in to mint a session
 * cookie.
 *
 * There is no public endpoint that can create an admin directly: the
 * Phase 00 fix for anonymous admin escalation makes `role` unsettable from
 * request bodies (`lib/auth.js`, `user.additionalFields.role.input: false`),
 * so the DB write here is the only way to reach that role in a test.
 *
 * Requires the app to have been built with createApp() (see helpers/app.js)
 * so the real better-auth handler is mounted at /api/auth/*.
 */
async function makeAdminSession(app) {
	const n = nextSequence();
	const email = `admin-${n}-${randomUUID()}@test.local`;
	const password = 'factory-test-password-1';
	const username = `admin_${n}_${randomUUID().slice(0, 8)}`;

	const signUpRes = await request(app)
		.post('/api/auth/sign-up/email')
		.send({ email, password, name: `Admin ${n}`, username });
	if (signUpRes.status !== 200) {
		throw new Error(
			`makeAdminSession: sign-up failed with ${signUpRes.status}: ${JSON.stringify(signUpRes.body)}`
		);
	}

	// Direct DB write — see the function-level comment for why this cannot go
	// through the public API.
	await User.updateOne({ email }, { $set: { role: 'admin' } });

	const signInRes = await request(app)
		.post('/api/auth/sign-in/email')
		.send({ email, password });
	if (signInRes.status !== 200) {
		throw new Error(
			`makeAdminSession: sign-in failed with ${signInRes.status}: ${JSON.stringify(signInRes.body)}`
		);
	}

	const cookies = signInRes.headers['set-cookie'];
	if (!cookies || cookies.length === 0) {
		throw new Error('makeAdminSession: sign-in did not return a session cookie');
	}

	return { cookies, email, username };
}

module.exports = { makeProduct, makeCombo, makeAdminSession };
