/**
 * Named lists of email addresses that a storefront's LIST rule can point at.
 *
 * Addresses are stored trimmed and lowercase (a CHECK), and every address handed
 * in here is folded the same way, so a list never holds two spellings of one
 * person. Deleting a list deletes the rules that name it (the foreign key
 * cascades): those storefronts admit fewer viewers, never more. `ruleCount` on a
 * list is how many rules that would remove.
 *
 * Records: `_id` is the uuid string, an unset description is an absent key.
 */
const { prisma } = require('../../lib/prisma');
const { toSkipTake, buildPaginationMeta } = require('@sab/shared');
const { RecordValidationError } = require('../errors');
const { asString } = require('../../utils/query-guard');
const { translating } = require('./errors');
const { containsInsensitive } = require('./like');
const { withTransaction } = require('./tx');
const { Problems, checkText, recordId } = require('./rules');
const { normalizeEmail } = require('./email-address');

const EDITABLE_FIELDS = ['name', 'description'];
const SEARCH_MAX_LENGTH = 100;
const INSERT_CHUNK = 1000;

const RECORD_INCLUDE = { _count: { select: { entries: true, rules: true } } };

/** A stored list (loaded with its counts) as a plain record. */
function toRecord(row) {
	const { id, description, _count, ...rest } = row;
	return {
		_id: id,
		...(description !== null && description !== undefined && { description }),
		...rest,
		entryCount: _count.entries,
		ruleCount: _count.rules
	};
}

function entryRecord({ id, ...rest }) {
	return { _id: id, ...rest };
}

/** Validated column values for the fields present in `fields`; on `creating`, the name is required. */
function columnsOf(fields, { creating }) {
	const problems = new Problems();
	const description = checkText(problems, 'description', fields.description, { max: 500, maxMessage: 'Mô tả không được vượt quá 500 ký tự' });
	const columns = {
		name: checkText(problems, 'name', creating && fields.name === undefined ? null : fields.name, {
			required: true, requiredMessage: 'Tên danh sách là bắt buộc', max: 80, maxMessage: 'Tên danh sách không được vượt quá 80 ký tự'
		}),
		description: description === '' ? null : description
	};
	problems.throwIfAny();
	return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

/** Every list by name, with how many addresses it holds and how many rules use it. */
async function list() {
	const rows = await prisma.emailList.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }], include: RECORD_INCLUDE });
	return rows.map(toRecord);
}

/** The list with this id, or null. @throws {InvalidIdError} */
function findById(id) {
	return translating(async () => {
		const row = await prisma.emailList.findUnique({ where: { id: recordId(id) }, include: RECORD_INCLUDE });
		return row ? toRecord(row) : null;
	});
}

/**
 * @param {{name: string, description?: string}} fields
 * @returns {Promise<object>}
 * @throws {RecordValidationError|DuplicateKeyError} `name` taken
 */
function create(fields) {
	return translating(async () => {
		const columns = columnsOf(fields || {}, { creating: true });
		return toRecord(await prisma.emailList.create({ data: columns, include: RECORD_INCLUDE }));
	});
}

/**
 * Rename and/or re-describe a list; null when it does not exist.
 *
 * @param {string} id
 * @param {{name?: string, description?: string|null}} changes
 * @returns {Promise<object|null>}
 * @throws {RecordValidationError|DuplicateKeyError|InvalidIdError}
 */
function update(id, changes) {
	const picked = Object.fromEntries(EDITABLE_FIELDS.filter((field) => changes[field] !== undefined).map((field) => [field, changes[field]]));
	return translating(async () => {
		const listId = recordId(id);
		const columns = columnsOf(picked, { creating: false });
		try {
			return toRecord(await prisma.emailList.update({ where: { id: listId }, data: columns, include: RECORD_INCLUDE }));
		} catch (err) {
			if (err && err.code === 'P2025') return null;
			throw err;
		}
	});
}

/** Delete a list with its addresses and the rules that name it; false when there was none. @throws {InvalidIdError} */
function remove(id) {
	return translating(async () => (await prisma.emailList.deleteMany({ where: { id: recordId(id) } })).count === 1);
}

/**
 * One page of a list's addresses, by address and then id. `page` and `limit` are
 * already clamped by the caller; `search` is a literal substring, case-insensitive.
 * An unknown list is an empty page.
 *
 * @param {string} listId
 * @param {{page: number, limit: number, search?: string}} query
 * @returns {Promise<{data: object[], meta: {page: number, limit: number, total: number, totalPages: number}}>}
 * @throws {InvalidIdError}
 */
function entriesPage(listId, { page, limit, search }) {
	return translating(async () => {
		const text = asString(search, SEARCH_MAX_LENGTH);
		const where = { emailListId: recordId(listId, 'listId'), ...(text && { email: containsInsensitive(text.trim().toLowerCase()) }) };
		const { skip, take } = toSkipTake(page, limit);
		const [rows, total] = await Promise.all([
			prisma.emailListEntry.findMany({ where, orderBy: [{ email: 'asc' }, { id: 'asc' }], skip, take }),
			prisma.emailListEntry.count({ where })
		]);
		return { data: rows.map(entryRecord), meta: buildPaginationMeta(total, { page, limit }) };
	});
}

/**
 * Add addresses to a list in one transaction. An address already in the list, or
 * repeated in `emails`, is skipped, not an error.
 *
 * @param {string} listId
 * @param {string[]} emails as typed; trimmed and lowercased here
 * @returns {Promise<{added: number, skipped: number}|null>} null when the list does not exist
 * @throws {RecordValidationError} an entry is not an email address (nothing is added)
 * @throws {InvalidIdError}
 */
function addEntries(listId, emails) {
	return translating(async () => {
		const emailListId = recordId(listId, 'listId');
		if (!Array.isArray(emails)) throw new RecordValidationError([{ field: 'emails', message: 'Danh sách email là bắt buộc' }]);
		const problems = new Problems();
		const folded = emails.map((email, index) => {
			const normalized = normalizeEmail(email);
			if (normalized === null) problems.add(`emails.${index}`, 'Email không hợp lệ');
			return normalized;
		});
		problems.throwIfAny();
		const unique = [...new Set(folded)];

		return withTransaction(async (tx) => {
			if (!(await tx.emailList.findUnique({ where: { id: emailListId }, select: { id: true } }))) return null;
			let added = 0;
			for (let from = 0; from < unique.length; from += INSERT_CHUNK) {
				const data = unique.slice(from, from + INSERT_CHUNK).map((email) => ({ emailListId, email }));
				added += (await tx.emailListEntry.createMany({ data, skipDuplicates: true })).count;
			}
			return { added, skipped: emails.length - added };
		});
	});
}

/** Remove one address of this list; false when there was none. @throws {InvalidIdError} */
function removeEntry(listId, entryId) {
	return translating(async () => {
		const where = { id: recordId(entryId, 'entryId'), emailListId: recordId(listId, 'listId') };
		return (await prisma.emailListEntry.deleteMany({ where })).count === 1;
	});
}

/** Remove every address of the list; returns how many there were. @throws {InvalidIdError} */
function clear(listId) {
	return translating(async () => (await prisma.emailListEntry.deleteMany({ where: { emailListId: recordId(listId, 'listId') } })).count);
}

module.exports = { list, findById, create, update, remove, entriesPage, addEntries, removeEntry, clear };
