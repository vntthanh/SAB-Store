/**
 * Replays the validation golden fixture against the real app.
 *
 * The fixture's base fields (`expect*`) are the reference behaviour captured
 * before the schema layer existed. A case whose behaviour changed on purpose
 * carries an `intentional` block with the new expectation and the reason;
 * every other case must reproduce its recorded status and error list.
 *
 * Capture (GOLDEN_CAPTURE=1) rebuilds the base fields from whatever the app
 * answers now, so it refuses to run over a fixture holding `intentional`
 * blocks unless GOLDEN_CAPTURE_DISCARD_INTENTIONAL=1 is also set.
 *
 * Two kinds of recorded 500 prove less than a body: a non-object JSON body
 * is rejected by the body parser before validation, and a change-password
 * request that passes validation reaches Better Auth with a wrong password
 * (now a 400 naming the currentPassword field, still not a validation reject).
 * For those the fixture only proves validation did not reject the request.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const { cases, MISSING } = require('./golden-cases');

const FIXTURE_PATH = path.resolve(__dirname, '../../../packages/shared/tests/fixtures/validation-golden.json');
const CAPTURE = process.env.GOLDEN_CAPTURE === '1';
const DISCARD_INTENTIONAL = process.env.GOLDEN_CAPTURE_DISCARD_INTENTIONAL === '1';
const PASSWORD_CHANGE_ROUTE = 'POST /api/seller/change-password';
const VALIDATION_MESSAGE = 'Dữ liệu không hợp lệ';

const caseKey = (c) => `${c.route} | ${c.name}${c.params ? ` | ${JSON.stringify(c.params)}` : ''}`;

// Deterministic order so a schema may report the same errors in another order.
const sortErrors = (errors) => [...errors].sort((a, b) =>
	a.field.localeCompare(b.field) || a.message.localeCompare(b.message));

function toJsonClean(value) {
	return JSON.parse(JSON.stringify(value, (_key, v) => (v === MISSING ? undefined : v)));
}

async function observe(app, cookies, c) {
	const [method, template] = c.route.split(' ');
	const url = Object.entries(c.params || {}).reduce((acc, [k, v]) => acc.replace(`:${k}`, v), template);
	const payload = c.rawBody !== undefined ? c.rawBody : JSON.stringify(c.body);

	let res;
	try {
		res = await request(app)[method.toLowerCase()](url)
			.set('Cookie', cookies)
			.set('Content-Type', 'application/json')
			.send(payload);
	} catch (error) {
		throw new Error(`request failed for ${caseKey(c)}: ${error.message}`);
	}

	const result = { status: res.status };
	const body = res.body;
	if (body && body.message === VALIDATION_MESSAGE && Array.isArray(body.errors)) {
		result.errors = body.errors;
	} else {
		if (body && typeof body.message === 'string') result.message = body.message;
		if (body && typeof body.code === 'string') result.code = body.code;
	}
	return result;
}

const expectationOf = (record) => {
	const source = record.intentional || record;
	const out = { status: source.expectStatus };
	if (source.expectErrors) out.errors = source.expectErrors;
	if (source.expectMessage !== undefined) out.message = source.expectMessage;
	if (source.expectCode !== undefined) out.code = source.expectCode;
	return out;
};

const normalise = (result) => ({ ...result, ...(result.errors && { errors: sortErrors(result.errors) }) });

describe('validation golden fixture', () => {
	let app;
	let cookies;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('has unique case keys', () => {
		const keys = cases.map(caseKey);
		expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
	});

	// One test body: the shared afterEach hook wipes every collection, session
	// included, so the admin session must live for the whole loop.
	const cleanDefinition = (c) => {
		const out = { route: c.route, name: c.name };
		if (c.params) out.params = c.params;
		if (c.rawBody !== undefined) out.rawBody = c.rawBody;
		else out.body = toJsonClean(c.body);
		return out;
	};

	const loadFixture = () => (fs.existsSync(FIXTURE_PATH) ? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) : []);

	// One test body: the shared afterEach hook wipes every collection, session
	// included, so the admin session must live for the whole loop.
	if (CAPTURE) {
		it('rewrites the fixture, then fails so a capture run is never mistaken for a pass', async () => {
			if (loadFixture().some((r) => r.intentional) && !DISCARD_INTENTIONAL) {
				throw new Error(
					'The fixture holds `intentional` blocks that a capture would drop. '
					+ 'Set GOLDEN_CAPTURE_DISCARD_INTENTIONAL=1 to capture anyway.',
				);
			}
			({ cookies } = await makeAdminSession(app));
			const records = [];
			for (const c of cases) {
				const result = await observe(app, cookies, c);
				const record = cleanDefinition(c);
				record.expectStatus = result.status;
				if (result.errors) record.expectErrors = result.errors;
				if (result.message !== undefined) record.expectMessage = result.message;
				if (result.code !== undefined) record.expectCode = result.code;
				records.push(record);
			}
			fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
			fs.writeFileSync(FIXTURE_PATH, `[\n${records.map((r) => `\t${JSON.stringify(r)}`).join(',\n')}\n]\n`);
			throw new Error(`Fixture rewritten with ${records.length} cases; rerun without GOLDEN_CAPTURE.`);
		}, 300000);
	} else {
		it('replays every recorded case', async () => {
			({ cookies } = await makeAdminSession(app));

			const records = loadFixture();
			expect(records.map(caseKey).sort()).toEqual(cases.map(caseKey).sort());

			// An edited case definition must be re-captured, not silently replayed
			// with the stale body the fixture still holds.
			const definitions = new Map(cases.map((c) => [caseKey(c), cleanDefinition(c)]));
			const stale = records
				.filter((r) => JSON.stringify(cleanDefinition(r)) !== JSON.stringify(definitions.get(caseKey(r))))
				.map(caseKey);
			expect(stale).toEqual([]);

			const reasons = records.filter((r) => r.intentional).map((r) => r.intentional.reason);
			expect(reasons.every((reason) => typeof reason === 'string' && reason.length > 0)).toBe(true);

			const mismatches = [];
			for (const record of records) {
				const observed = normalise(await observe(app, cookies, record));
				const expected = normalise(expectationOf(record));
				const passThrough500 = record.route === PASSWORD_CHANGE_ROUTE
					&& expected.status === 500 && !expected.errors;
				const matches = passThrough500
					? !observed.errors && observed.message !== VALIDATION_MESSAGE
					: JSON.stringify(observed) === JSON.stringify(expected);
				if (!matches) mismatches.push({ case: caseKey(record), expected, observed });
			}
			// Lets a reviewer classify a large diff outside the test run.
			if (process.env.GOLDEN_DIFF_OUT) fs.writeFileSync(process.env.GOLDEN_DIFF_OUT, JSON.stringify(mismatches, null, '\t'));
			expect(mismatches.map((m) => m.case)).toEqual([]);
		}, 300000);
	}
});
