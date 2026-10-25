/**
 * Storefronts on Postgres: the shop fronts a customer browses, who may see the
 * private ones, and the access rules behind that.
 *
 * Records: `_id` is the uuid string, an unset description is an absent key.
 * Lists order by `sortOrder` and then id, so a tie never reorders between reads.
 *
 * Access (`viewerCanAccess`, `accessibleIds`): a viewer is admitted by an EMAIL
 * rule (the address), a DOMAIN rule (the part after `@`, exact: `sab.edu.vn` does
 * not admit `x@mail.sab.edu.vn`) or a LIST rule (the address is an entry of that
 * list). Rows hold lowercase values (CHECKs), and the viewer's address is folded
 * the same way here, so the caller may pass it as typed. These two only evaluate
 * the rules: a PUBLIC storefront has none, and the caller decides what a public
 * one means.
 *
 * Two invariants live here because the database cannot express them: at least one
 * storefront stays active, and a storefront that products, combos or orders still
 * use is never deleted. The first is enforced under a row lock on the active
 * storefronts, so two concurrent changes that would each leave the other as the
 * last one queue up instead of both succeeding.
 */
const { prisma } = require('../../lib/prisma');
const { Prisma } = require('../../generated/prisma/client');
const { InvalidIdError, DuplicateKeyError, RecordValidationError, ConflictError, CONFLICT_CODES } = require('../errors');
const { translating, translateWriteError } = require('./errors');
const { withTransaction } = require('./tx');
const { Problems, checkText, checkBoolean, checkEnum, recordId } = require('./rules');
const { normalizeEmail, normalizeDomain } = require('./email-address');
const { DEFAULT_STOREFRONT_ID } = require('../default-storefront');

const VISIBILITIES = ['PUBLIC', 'PRIVATE'];
const RULE_TYPES = ['EMAIL', 'DOMAIN', 'LIST'];
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The only fields an edit may change. `sortOrder` moves through `reorder` alone.
const EDITABLE_FIELDS = ['slug', 'name', 'description', 'visibility', 'isActive'];

const LIST_ORDER = [{ sortOrder: 'asc' }, { id: 'asc' }];

const clientOf = (tx) => tx || prisma;
const dropNull = (value) => (value === null ? undefined : value);

/** A stored row as a plain record: `_id` is the uuid string, an unset description is absent. */
function toRecord(row) {
	const { id, description, ...rest } = row;
	return { _id: id, ...(description !== null && description !== undefined && { description }), ...rest };
}

function ruleRecord(row) {
	const { id, value, emailListId, createdBy, emailList, ...rest } = row;
	return {
		_id: id,
		...rest,
		...(value !== null && value !== undefined && { value }),
		...(emailListId !== null && emailListId !== undefined && { emailListId }),
		...(createdBy !== null && createdBy !== undefined && { createdBy }),
		...(emailList && { emailListName: emailList.name, entryCount: emailList._count.entries })
	};
}

/**
 * Validated column values for the fields present in `fields`; on `creating`, slug
 * and name are required.
 *
 * @throws {RecordValidationError} every field that breaks a rule
 */
function columnsOf(fields, { creating }) {
	const problems = new Problems();
	const given = (name) => (creating && fields[name] === undefined ? null : fields[name]);

	const slug = checkText(problems, 'slug', given('slug'), {
		required: true, requiredMessage: 'Đường dẫn cửa hàng là bắt buộc', max: 60, maxMessage: 'Đường dẫn không được vượt quá 60 ký tự'
	});
	if (typeof slug === 'string' && slug !== '' && !SLUG_PATTERN.test(slug)) {
		problems.add('slug', 'Đường dẫn chỉ gồm chữ thường, số và dấu gạch ngang giữa các từ');
	}
	const description = checkText(problems, 'description', fields.description, { max: 500, maxMessage: 'Mô tả không được vượt quá 500 ký tự' });

	const columns = {
		slug,
		name: checkText(problems, 'name', given('name'), {
			required: true, requiredMessage: 'Tên cửa hàng là bắt buộc', max: 80, maxMessage: 'Tên cửa hàng không được vượt quá 80 ký tự'
		}),
		description: description === '' ? null : description,
		visibility: checkEnum(problems, 'visibility', dropNull(fields.visibility), VISIBILITIES),
		isActive: checkBoolean(problems, 'isActive', dropNull(fields.isActive))
	};
	problems.throwIfAny();
	return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

const lastActiveError = () => new ConflictError(CONFLICT_CODES.LAST_ACTIVE_STOREFRONT, 'At least one storefront must stay active');
// Every product and online order without a storefront of its own falls back to it, so its row must outlive any admin action.
const defaultError = () => new ConflictError(CONFLICT_CODES.DEFAULT_STOREFRONT, 'The default storefront cannot be deleted');
const inUseError = (details, cause) => new ConflictError(CONFLICT_CODES.STOREFRONT_IN_USE, 'The storefront is still used by products, combos or orders', { details, cause });

/**
 * Locks every active storefront, in id order so two callers never deadlock, and
 * returns their ids. Under Read Committed a waiting caller re-reads the rows once
 * the first commits, so it sees the other's deactivation.
 */
async function lockActiveIds(tx) {
	const rows = await tx.$queryRaw`SELECT id FROM storefronts WHERE is_active = true ORDER BY id FOR UPDATE`;
	return rows.map((row) => row.id);
}

/** Storefronts offered to customers (active), in display order. */
async function listActive() {
	return (await prisma.storefront.findMany({ where: { isActive: true }, orderBy: LIST_ORDER })).map(toRecord);
}

/** Every storefront, active or not, in display order (admin). */
async function listAll() {
	return (await prisma.storefront.findMany({ orderBy: LIST_ORDER })).map(toRecord);
}

/** The storefront with this slug, or null. */
async function findBySlug(slug) {
	if (typeof slug !== 'string' || slug === '') return null;
	const row = await prisma.storefront.findUnique({ where: { slug } });
	return row ? toRecord(row) : null;
}

/** The storefront with this id, or null. @throws {InvalidIdError} */
function findById(id, tx) {
	return translating(async () => {
		const row = await clientOf(tx).storefront.findUnique({ where: { id: recordId(id) } });
		return row ? toRecord(row) : null;
	});
}

/**
 * Insert a storefront at the end of the display order.
 *
 * @param {{slug: string, name: string, description?: string, visibility?: 'PUBLIC'|'PRIVATE', isActive?: boolean}} fields
 * @returns {Promise<object>}
 * @throws {RecordValidationError|DuplicateKeyError} `slug` taken
 */
function create(fields) {
	return translating(async () => {
		const columns = columnsOf(fields || {}, { creating: true });
		return withTransaction(async (tx) => {
			const { _max } = await tx.storefront.aggregate({ _max: { sortOrder: true } });
			return toRecord(await tx.storefront.create({ data: { ...columns, sortOrder: (_max.sortOrder ?? -1) + 1 } }));
		});
	});
}

/**
 * Apply the editable fields of `changes` that are not undefined; null when the
 * storefront does not exist.
 *
 * @param {string} id
 * @param {object} changes
 * @returns {Promise<object|null>}
 * @throws {RecordValidationError|DuplicateKeyError|InvalidIdError|ConflictError} LAST_ACTIVE_STOREFRONT
 */
function update(id, changes) {
	const picked = Object.fromEntries(EDITABLE_FIELDS.filter((field) => changes[field] !== undefined).map((field) => [field, changes[field]]));
	return translating(async () => {
		const storefrontId = recordId(id);
		const columns = columnsOf(picked, { creating: false });
		return withTransaction(async (tx) => {
			if (columns.isActive === false) {
				const active = await lockActiveIds(tx);
				if (active.length === 1 && active[0] === storefrontId) throw lastActiveError();
			}
			try {
				return toRecord(await tx.storefront.update({ where: { id: storefrontId }, data: columns }));
			} catch (err) {
				if (err && err.code === 'P2025') return null;
				throw err;
			}
		});
	});
}

/**
 * Give the listed storefronts `sortOrder` = their index, in one transaction.
 * Storefronts not listed keep theirs. Returns every storefront afterwards.
 *
 * @param {string[]} ids
 * @returns {Promise<object[]>}
 * @throws {RecordValidationError} an id repeated or unknown (nothing is changed)
 * @throws {InvalidIdError}
 */
function reorder(ids) {
	return translating(async () => {
		if (!Array.isArray(ids)) throw new InvalidIdError('Invalid value for ids', { path: 'ids', value: ids });
		const ordered = ids.map((id) => recordId(id, 'ids'));
		if (new Set(ordered).size !== ordered.length) {
			throw new RecordValidationError([{ field: 'ids', message: 'Danh sách cửa hàng có mã bị lặp' }]);
		}
		return withTransaction(async (tx) => {
			// Rows are written in id order, whatever order they are listed in, so two
			// reorders that overlap never wait on each other's rows in opposite order.
			const byId = [...ordered.entries()].sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
			for (const [index, id] of byId) {
				const { count } = await tx.storefront.updateMany({ where: { id }, data: { sortOrder: index } });
				if (count !== 1) throw new RecordValidationError([{ field: 'ids', message: 'Có cửa hàng không tồn tại' }]);
			}
			return (await tx.storefront.findMany({ orderBy: LIST_ORDER })).map(toRecord);
		});
	});
}

/**
 * Delete a storefront and its access rules.
 *
 * @param {string} id
 * @returns {Promise<boolean>} false when there was none
 * @throws {ConflictError} STOREFRONT_IN_USE (`details`: how many products, combo links and orders), LAST_ACTIVE_STOREFRONT, or DEFAULT_STOREFRONT (the default one is never deleted; it may be deactivated)
 * @throws {InvalidIdError}
 */
function remove(id) {
	return translating(async () => {
		const storefrontId = recordId(id);
		if (storefrontId === DEFAULT_STOREFRONT_ID) throw defaultError();
		return withTransaction(async (tx) => {
			// Locked whatever the row looked like a moment ago: an activation that
			// committed since would otherwise let the last active one be removed.
			const active = await lockActiveIds(tx);
			if (active.length === 1 && active[0] === storefrontId) throw lastActiveError();
			const products = await tx.product.count({ where: { storefrontId } });
			const combos = await tx.comboStorefront.count({ where: { storefrontId } });
			const orders = await tx.order.count({ where: { storefrontId } });
			if (products + combos + orders > 0) throw inUseError({ products, combos, orders });
			try {
				await tx.storefront.delete({ where: { id: storefrontId } });
			} catch (err) {
				// A row that pointed at it appeared after the counts.
				if (err && err.code === 'P2003') throw inUseError({}, err);
				if (err && err.code === 'P2025') return false;
				throw err;
			}
			return true;
		});
	});
}

// ---- access ----

/**
 * The SQL condition "this rule admits `email`", over a `storefront_access_rules`
 * row aliased `r`. Typed parameters only; `email` is already folded.
 */
function ruleAdmits(email) {
	return Prisma.sql`(
		(r.type = 'EMAIL' AND r.value = ${email}::text)
		OR (r.type = 'DOMAIN' AND r.value = split_part(${email}::text, '@', 2))
		OR (r.type = 'LIST' AND EXISTS (
			SELECT 1 FROM email_list_entries e WHERE e.email_list_id = r.email_list_id AND e.email = ${email}::text
		))
	)`;
}

/**
 * True when some rule of the storefront admits `email`: one statement. An address
 * that is not an address admits nobody.
 *
 * @param {string} storefrontId
 * @param {string} email as typed; trimmed and lowercased here
 * @param {object|null} [tx]
 * @returns {Promise<boolean>}
 * @throws {InvalidIdError}
 */
function viewerCanAccess(storefrontId, email, tx) {
	return translating(async () => {
		const id = recordId(storefrontId, 'storefrontId');
		const folded = normalizeEmail(email);
		if (folded === null) return false;
		const [row] = await clientOf(tx).$queryRaw`
			SELECT EXISTS (
				SELECT 1 FROM storefront_access_rules r
				WHERE r.storefront_id = ${id}::uuid AND ${ruleAdmits(folded)}
			) AS allowed`;
		return row.allowed === true;
	});
}

/**
 * The ids of the active PRIVATE storefronts a rule admits `email` to, in display
 * order: one statement. Public storefronts are not listed (they need no rule).
 *
 * @param {string} email as typed; trimmed and lowercased here
 * @param {object|null} [tx]
 * @returns {Promise<string[]>}
 */
async function accessibleIds(email, tx) {
	const folded = normalizeEmail(email);
	if (folded === null) return [];
	const rows = await clientOf(tx).$queryRaw`
		SELECT s.id FROM storefronts s
		WHERE s.visibility = 'PRIVATE' AND s.is_active = true
			AND EXISTS (SELECT 1 FROM storefront_access_rules r WHERE r.storefront_id = s.id AND ${ruleAdmits(folded)})
		ORDER BY s.sort_order, s.id`;
	return rows.map((row) => row.id);
}

// ---- rules ----

/** The rules of a storefront, oldest first; a LIST rule carries the list's name and entry count. @throws {InvalidIdError} */
function listRules(storefrontId) {
	return translating(async () => {
		const rows = await prisma.storefrontAccessRule.findMany({
			where: { storefrontId: recordId(storefrontId, 'storefrontId') },
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
			include: { emailList: { select: { name: true, _count: { select: { entries: true } } } } }
		});
		return rows.map(ruleRecord);
	});
}

/** The columns of a rule: the type decides whether it carries a value or a list. */
function ruleColumns({ type, value, emailListId }) {
	const problems = new Problems();
	let columns = {};
	if (!RULE_TYPES.includes(type)) {
		problems.add('type', 'Loại quy tắc không hợp lệ');
	} else if (type === 'LIST') {
		if (value !== undefined && value !== null) problems.add('value', 'Quy tắc theo danh sách không có giá trị');
		if (emailListId === undefined || emailListId === null) problems.add('emailListId', 'Danh sách email là bắt buộc');
		else columns = { type, emailListId: recordId(emailListId, 'emailListId') };
	} else {
		if (emailListId !== undefined && emailListId !== null) problems.add('emailListId', 'Quy tắc này không dùng danh sách email');
		const folded = type === 'EMAIL' ? normalizeEmail(value) : normalizeDomain(value);
		if (folded === null) problems.add('value', type === 'EMAIL' ? 'Email không hợp lệ' : 'Tên miền không hợp lệ');
		else columns = { type, value: folded };
	}
	problems.throwIfAny();
	return columns;
}

/**
 * Add a rule. EMAIL and DOMAIN take `value` (folded to lowercase), LIST takes
 * `emailListId`.
 *
 * @param {{storefrontId: string, type: 'EMAIL'|'DOMAIN'|'LIST', value?: string, emailListId?: string, createdBy?: string}} rule
 * @returns {Promise<object>}
 * @throws {RecordValidationError|InvalidIdError}
 * @throws {DuplicateKeyError} the storefront already has this rule (`value` for EMAIL/DOMAIN, `emailListId` for LIST)
 * @throws {ConflictError} REFERENCE_VIOLATION: the storefront or list does not exist
 */
function addRule({ storefrontId, createdBy, ...rule } = {}) {
	return translating(async () => {
		const columns = ruleColumns(rule);
		const data = {
			...columns,
			storefrontId: recordId(storefrontId, 'storefrontId'),
			...(createdBy !== undefined && createdBy !== null && { createdBy: recordId(createdBy, 'createdBy') })
		};
		try {
			return ruleRecord(await prisma.storefrontAccessRule.create({ data }));
		} catch (err) {
			// The unique indexes are compound (and one partial); name the column a caller can act on.
			if (translateWriteError(err) instanceof DuplicateKeyError) {
				throw new DuplicateKeyError([columns.type === 'LIST' ? 'emailListId' : 'value'], { cause: err });
			}
			throw err;
		}
	});
}

/** Remove a rule of this storefront; false when there was none. @throws {InvalidIdError} */
function removeRule(storefrontId, ruleId) {
	return translating(async () => {
		const where = { id: recordId(ruleId, 'ruleId'), storefrontId: recordId(storefrontId, 'storefrontId') };
		return (await prisma.storefrontAccessRule.deleteMany({ where })).count === 1;
	});
}

module.exports = {
	listActive,
	listAll,
	findBySlug,
	findById,
	create,
	update,
	reorder,
	remove,
	viewerCanAccess,
	accessibleIds,
	listRules,
	addRule,
	removeRule
};
