const request = require('supertest');
const { randomUUID } = require('crypto');
const { POSTGRES } = require('../helpers/backend');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeSellerSession } = require('../helpers/factories');

describe.skipIf(!POSTGRES)('admin email list API', () => {
	let app;
	let cookies;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		({ cookies } = await makeAdminSession(app));
	});

	const as = (method, path, jar = cookies) => request(app)[method](`/api/admin${path}`).set('Cookie', jar);
	const makeList = async (name = 'Lop A', extra = {}) => (await as('post', '/email-lists').send({ name, ...extra })).body.data;
	const addEntries = (id, emails) => as('post', `/email-lists/${id}/entries`).send({ emails });
	const emailsOf = (res) => res.body.data.map((entry) => entry.email);

	it('answers 401 without a session and 403 to a seller, on lists and entries alike', async () => {
		const list = await makeList();
		const seller = await makeSellerSession(app);

		const calls = [
			['get', '/email-lists'],
			['post', '/email-lists'],
			['put', `/email-lists/${list._id}`],
			['delete', `/email-lists/${list._id}`],
			['get', `/email-lists/${list._id}/entries`],
			['post', `/email-lists/${list._id}/entries`],
			['delete', `/email-lists/${list._id}/entries`]
		];
		for (const [method, path] of calls) {
			expect((await request(app)[method](`/api/admin${path}`).send({})).status).toBe(401);
			expect((await as(method, path, seller.cookies).send({ name: 'x', emails: ['a@gmail.com'] })).status).toBe(403);
		}
		expect((await as('get', '/email-lists')).body.data).toHaveLength(1);
		expect((await as('get', `/email-lists/${list._id}/entries`)).body.meta.total).toBe(0);
	});

	describe('lists', () => {
		it('creates a list, trims the name and reports counts', async () => {
			const res = await as('post', '/email-lists').send({ name: '  Lớp 12A  ', description: 'Khối 12' });

			expect(res.status).toBe(201);
			expect(res.body.data).toMatchObject({ name: 'Lớp 12A', description: 'Khối 12', entryCount: 0, ruleCount: 0 });
		});

		it('lists by name', async () => {
			await makeList('Beta');
			await makeList('Alpha');

			const res = await as('get', '/email-lists');

			expect(res.body.data.map((list) => list.name)).toEqual(['Alpha', 'Beta']);
		});

		it('refuses a missing or long name with the schema errors and a taken name with EMAIL_LIST_NAME_TAKEN', async () => {
			await makeList('Dup');

			const missing = await as('post', '/email-lists').send({ description: 'x' });
			const long = await as('post', '/email-lists').send({ name: 'x'.repeat(81) });
			const taken = await as('post', '/email-lists').send({ name: 'Dup' });

			expect(missing.status).toBe(400);
			expect(missing.body.errors[0].field).toBe('name');
			expect(long.status).toBe(400);
			expect(taken.status).toBe(409);
			expect(taken.body.code).toBe('EMAIL_LIST_NAME_TAKEN');
		});

		it('renames, clears the description with null, and answers 404 for an unknown list and 400 for an empty body', async () => {
			const list = await makeList('Old', { description: 'Mô tả' });

			const renamed = await as('put', `/email-lists/${list._id}`).send({ name: 'New' });
			const cleared = await as('put', `/email-lists/${list._id}`).send({ description: null });
			const unknown = await as('put', `/email-lists/${randomUUID()}`).send({ name: 'x' });
			const empty = await as('put', `/email-lists/${list._id}`).send({});

			expect(renamed.body.data).toMatchObject({ name: 'New', description: 'Mô tả' });
			expect(cleared.body.data).toMatchObject({ name: 'New' });
			expect(cleared.body.data).not.toHaveProperty('description');
			expect(unknown.status).toBe(404);
			expect(unknown.body.code).toBe('EMAIL_LIST_NOT_FOUND');
			expect(empty.status).toBe(400);
		});

		it('renaming onto a taken name is 409', async () => {
			await makeList('One');
			const two = await makeList('Two');

			const res = await as('put', `/email-lists/${two._id}`).send({ name: 'One' });

			expect(res.status).toBe(409);
			expect(res.body.code).toBe('EMAIL_LIST_NAME_TAKEN');
		});

		it('deletes a list with its entries, once', async () => {
			const list = await makeList();
			await addEntries(list._id, ['a@gmail.com']);

			const first = await as('delete', `/email-lists/${list._id}`);
			const second = await as('delete', `/email-lists/${list._id}`);

			expect(first.status).toBe(200);
			expect(second.status).toBe(404);
			expect((await as('get', '/email-lists')).body.data).toEqual([]);
		});
	});

	describe('entries', () => {
		let list;

		beforeEach(async () => {
			list = await makeList();
		});

		it('adds addresses folded to lowercase and counts repeats and known addresses as skipped', async () => {
			const first = await addEntries(list._id, ['A@Gmail.com', ' b@gmail.com ', 'a@gmail.com']);
			const second = await addEntries(list._id, ['B@GMAIL.com', 'c@gmail.com']);

			expect(first.status).toBe(200);
			expect(first.body.data).toEqual({ added: 2, skipped: 1 });
			expect(second.body.data).toEqual({ added: 1, skipped: 1 });
			expect(emailsOf(await as('get', `/email-lists/${list._id}/entries`))).toEqual(['a@gmail.com', 'b@gmail.com', 'c@gmail.com']);
			expect((await as('get', '/email-lists')).body.data[0].entryCount).toBe(3);
		});

		it('adds nothing when one address is invalid, and names which', async () => {
			const res = await addEntries(list._id, ['ok@gmail.com', 'not-an-email']);

			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body.errors)).toContain('emails');
			expect((await as('get', `/email-lists/${list._id}/entries`)).body.meta.total).toBe(0);
		});

		it.each([
			['no emails key', {}],
			['an empty array', { emails: [] }],
			['emails that is not an array', { emails: 'a@gmail.com' }]
		])('answers 400 for %s', async (_label, body) => {
			const res = await as('post', `/email-lists/${list._id}/entries`).send(body);

			expect(res.status).toBe(400);
		});

		it('accepts 5000 addresses and refuses 5001', async () => {
			const emails = (count) => Array.from({ length: count }, (_, i) => `user${i}@gmail.com`);

			const over = await addEntries(list._id, emails(5001));
			const exact = await addEntries(list._id, emails(5000));

			expect(over.status).toBe(400);
			expect(exact.body.data).toEqual({ added: 5000, skipped: 0 });
		}, 30_000);

		it('answers 404 when the list does not exist', async () => {
			const post = await addEntries(randomUUID(), ['a@gmail.com']);
			const get = await as('get', `/email-lists/${randomUUID()}/entries`);
			const clear = await as('delete', `/email-lists/${randomUUID()}/entries`);

			expect(post.status).toBe(404);
			expect(post.body.code).toBe('EMAIL_LIST_NOT_FOUND');
			expect(get.status).toBe(404);
			expect(clear.status).toBe(404);
		});

		describe('paging and search', () => {
			beforeEach(async () => {
				await addEntries(list._id, Array.from({ length: 5 }, (_, i) => `member${i}@gmail.com`).concat('boss@sab.edu.vn'));
			});

			it('answers the shared envelope, ordered by address', async () => {
				const res = await as('get', `/email-lists/${list._id}/entries`).query({ page: 2, limit: 4 });

				expect(res.status).toBe(200);
				expect(res.body.success).toBe(true);
				expect(emailsOf(res)).toEqual(['member3@gmail.com', 'member4@gmail.com']);
				expect(res.body.meta).toEqual({ page: 2, limit: 4, total: 6, totalPages: 2 });
			});

			it('searches case-insensitively as a literal substring and counts the matches', async () => {
				const sab = await as('get', `/email-lists/${list._id}/entries`).query({ search: 'SAB.EDU' });
				const wildcard = await as('get', `/email-lists/${list._id}/entries`).query({ search: '%' });
				const none = await as('get', `/email-lists/${list._id}/entries`).query({ search: 'nobody' });

				expect(emailsOf(sab)).toEqual(['boss@sab.edu.vn']);
				expect(sab.body.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
				expect(wildcard.body.meta.total).toBe(0);
				expect(none.body.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
			});

			it('clamps page and limit and ignores a search that is not a string', async () => {
				const clamped = await as('get', `/email-lists/${list._id}/entries`).query({ page: '-3', limit: '9999' });
				const operator = await as('get', `/email-lists/${list._id}/entries?search[$ne]=x`);

				expect(clamped.status).toBe(200);
				expect(clamped.body.meta).toMatchObject({ page: 1, limit: 100, total: 6 });
				expect(operator.status).toBe(200);
				expect(operator.body.meta.total).toBe(6);
			});
		});

		describe('removal', () => {
			it('removes one entry through its own list only, once', async () => {
				const other = await makeList('Other');
				await addEntries(list._id, ['a@gmail.com', 'b@gmail.com']);
				const [{ _id: entryId }] = (await as('get', `/email-lists/${list._id}/entries`)).body.data;

				const wrongList = await as('delete', `/email-lists/${other._id}/entries/${entryId}`);
				const removed = await as('delete', `/email-lists/${list._id}/entries/${entryId}`);
				const again = await as('delete', `/email-lists/${list._id}/entries/${entryId}`);

				expect(wrongList.status).toBe(404);
				expect(removed.status).toBe(200);
				expect(again.status).toBe(404);
				expect(emailsOf(await as('get', `/email-lists/${list._id}/entries`))).toEqual(['b@gmail.com']);
			});

			it('answers 400 for a malformed entry id', async () => {
				const res = await as('delete', `/email-lists/${list._id}/entries/nope`);

				expect(res.status).toBe(400);
			});

			it('empties the list and says how many it removed, leaving other lists alone', async () => {
				const other = await makeList('Other');
				await addEntries(list._id, ['a@gmail.com', 'b@gmail.com']);
				await addEntries(other._id, ['a@gmail.com']);

				const res = await as('delete', `/email-lists/${list._id}/entries`);

				expect(res.body.data).toEqual({ removed: 2 });
				expect((await as('get', `/email-lists/${list._id}/entries`)).body.meta.total).toBe(0);
				expect((await as('get', `/email-lists/${other._id}/entries`)).body.meta.total).toBe(1);
			});
		});
	});
});
