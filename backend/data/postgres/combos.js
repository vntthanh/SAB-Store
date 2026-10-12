/**
 * Combos on Postgres: the same functions, arguments and plain records as
 * data/mongo/combos.js. The category requirements are rows of
 * `combo_category_requirements`, read back in `position` order, and the nested
 * `_id` of a requirement is that row's uuid string.
 *
 * Every list orders priority first, then newest, then id, so two reads of a tie
 * never come back in different orders.
 */
const { prisma } = require('../../lib/prisma');
const { SALES_CHANNELS, assertSaleChannel } = require('../sale-channels');
const { PUBLIC_CODE_PATTERN, withPublicCodeRetry } = require('../../utils/public-code');
const { translating } = require('./errors');
const { withTransaction } = require('./tx');
const { drawCodeAndSlug, slugFor, publicCodeBackfill } = require('./public-code');
const { Problems, checkText, checkNumber, checkBoolean, checkEnum, recordId } = require('./rules');

// The only fields an edit may change.
const EDITABLE_FIELDS = ['name', 'description', 'price', 'categoryRequirements', 'priority', 'isActive', 'salesChannel'];

const OFFERED_ORDER = [{ priority: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
const REQUIREMENT_SELECT = { select: { id: true, category: true, quantity: true }, orderBy: { position: 'asc' } };

const clientOf = (tx) => tx || prisma;

/** A stored combo (with its requirements loaded, when asked for) as a plain record. */
function toRecord(row) {
	const { id, requirements, ...rest } = row;
	const record = { _id: id };
	for (const [key, value] of Object.entries(rest)) {
		if (value !== null || key !== 'description') record[key] = value;
	}
	if (requirements) record.categoryRequirements = requirements.map(({ id: requirementId, category, quantity }) => ({ category, quantity, _id: requirementId }));
	return record;
}

/** Prisma `select` for the record fields a caller names; the id always comes along. */
function selectOf(fields) {
	const select = { id: true };
	for (const field of fields) {
		if (field === 'categoryRequirements') select.requirements = REQUIREMENT_SELECT;
		else if (field !== '_id') select[field] = true;
	}
	return select;
}

const sellableWhere = (channel) => {
	assertSaleChannel(channel);
	return { isActive: true, salesChannel: { in: ['all', channel] } };
};

/**
 * Validated column values and requirement rows for the fields present in
 * `fields`; on `creating`, the required ones must be there.
 *
 * @returns {{columns: object, requirements?: {category: string, quantity: number}[]}}
 * @throws {RecordValidationError}
 */
function valuesOf(fields, { creating }) {
	const problems = new Problems();
	const given = (name) => (creating && fields[name] === undefined ? null : fields[name]);

	let requirements;
	if (fields.categoryRequirements !== undefined || creating) {
		const list = fields.categoryRequirements;
		if (!Array.isArray(list) || list.length === 0) {
			problems.add('categoryRequirements', Array.isArray(list) ? 'Combo phải có ít nhất một yêu cầu danh mục' : 'Yêu cầu danh mục là bắt buộc');
		} else {
			requirements = list.map((entry, index) => {
				const item = entry && typeof entry === 'object' ? entry : {};
				return {
					category: checkText(problems, `categoryRequirements.${index}.category`, item.category ?? null, { required: true, requiredMessage: 'Danh mục là bắt buộc' }),
					quantity: checkNumber(problems, `categoryRequirements.${index}.quantity`, item.quantity ?? null, {
						required: true, requiredMessage: 'Số lượng là bắt buộc', min: 1, minMessage: 'Số lượng phải >= 1', integer: true, integerMessage: 'Số lượng phải là số nguyên'
					})
				};
			});
		}
	}

	let publicCode;
	if (fields.publicCode !== undefined && fields.publicCode !== null) {
		publicCode = fields.publicCode;
		if (typeof publicCode !== 'string' || !PUBLIC_CODE_PATTERN.test(publicCode)) problems.add('publicCode', `Path \`publicCode\` is invalid (${String(publicCode)}).`);
	}

	const columns = {
		name: checkText(problems, 'name', given('name'), {
			required: true, requiredMessage: 'Tên combo là bắt buộc', max: 100, maxMessage: 'Tên combo không được vượt quá 100 ký tự'
		}),
		description: checkText(problems, 'description', fields.description, { max: 500, maxMessage: 'Mô tả không được vượt quá 500 ký tự' }),
		price: checkNumber(problems, 'price', given('price'), {
			required: true, requiredMessage: 'Giá combo là bắt buộc', min: 0, minMessage: 'Giá không được âm', integer: true, integerMessage: 'Giá phải là số nguyên (VND)'
		}),
		// null for a NOT NULL column means "not given": the default applies on create, the stored value stays on update.
		priority: checkNumber(problems, 'priority', fields.priority ?? undefined, { integer: true, integerMessage: 'Độ ưu tiên phải là số nguyên' }),
		isActive: checkBoolean(problems, 'isActive', fields.isActive ?? undefined),
		salesChannel: checkEnum(problems, 'salesChannel', fields.salesChannel ?? undefined, SALES_CHANNELS),
		publicCode
	};
	problems.throwIfAny();
	return { columns: Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined)), requirements };
}

const requirementRows = (requirements) => requirements.map((entry, position) => ({ position, category: entry.category, quantity: entry.quantity }));

/**
 * Combos that may discount an order on `channel`, offered order first, as plain
 * records, optionally only the one with this `publicCode`. Validates `channel`
 * synchronously, like `products.findSellable`.
 *
 * @param {'online'|'offline'} channel
 * @param {{publicCode?: string}} [options]
 * @returns {Promise<object[]>}
 * @throws {TypeError} channel missing or unknown
 */
function findSellable(channel, { publicCode } = {}) {
	const where = { ...sellableWhere(channel), ...(publicCode !== undefined && { publicCode }) };
	return prisma.combo.findMany({ where, orderBy: OFFERED_ORDER, include: { requirements: REQUIREMENT_SELECT } }).then((rows) => rows.map(toRecord));
}

/**
 * The combos pricing may apply on `channel`, in offered order; `_id` is the
 * lowercase uuid string.
 *
 * @param {'online'|'offline'} channel
 * @param {string[]} fields
 * @param {object|null} [tx]
 * @returns {Promise<object[]>}
 */
async function findSellableForPricing(channel, fields, tx) {
	const rows = await clientOf(tx).combo.findMany({ where: sellableWhere(channel), orderBy: OFFERED_ORDER, select: selectOf(fields) });
	return rows.map(toRecord);
}

/** Every combo, offered order first, optionally only the active or only the stopped ones. */
async function list({ active } = {}) {
	const rows = await prisma.combo.findMany({ where: active === undefined ? {} : { isActive: active }, orderBy: OFFERED_ORDER, include: { requirements: REQUIREMENT_SELECT } });
	return rows.map(toRecord);
}

/** The combos that may discount an order on `channel`, offered order first. @throws {TypeError} */
async function listSellable(channel) {
	return findSellable(channel);
}

/** The name of every combo. */
async function listNames() {
	const rows = await prisma.combo.findMany({ select: { name: true } });
	return rows.map((row) => row.name);
}

/** True when a combo with this id exists. @throws {InvalidIdError} */
async function exists(id) {
	return (await prisma.combo.findUnique({ where: { id: recordId(id) }, select: { id: true } })) !== null;
}

/** The combo with this id, or null. @throws {InvalidIdError} */
function findById(id) {
	return translating(async () => {
		const row = await prisma.combo.findUnique({ where: { id: recordId(id) }, include: { requirements: REQUIREMENT_SELECT } });
		return row ? toRecord(row) : null;
	});
}

/**
 * Insert a combo with its requirements in one statement group, drawing a new
 * public code when one collides. A `publicCode` in `data` (a restore) is tried
 * once. Not for use inside a caller's transaction: a collision would abort it.
 *
 * @param {object} data
 * @returns {Promise<object>}
 * @throws {RecordValidationError|DuplicateKeyError|InvalidIdError}
 */
function create(data) {
	const attempt = () => translating(async () => {
		const { columns: { publicCode: supplied, ...columns }, requirements } = valuesOf(data, { creating: true });
		const row = await prisma.combo.create({
			data: {
				...columns,
				...drawCodeAndSlug(columns.name, supplied),
				...(data._id !== undefined && { id: recordId(data._id) }),
				requirements: { create: requirementRows(requirements) }
			},
			include: { requirements: REQUIREMENT_SELECT }
		});
		return toRecord(row);
	});
	return withPublicCodeRetry(attempt, { maxAttempts: data && data.publicCode ? 1 : undefined });
}

/**
 * Apply the editable fields of `changes` that are not undefined and return the
 * combo as stored, or null when it does not exist. Given requirements replace
 * the whole list. The combo row is locked first, so two edits of one combo run
 * one after the other instead of interleaving their delete and insert of rows.
 *
 * @param {string} id
 * @param {object} changes
 * @returns {Promise<object|null>}
 * @throws {RecordValidationError|InvalidIdError}
 */
function update(id, changes) {
	const picked = Object.fromEntries(EDITABLE_FIELDS.filter((field) => changes[field] !== undefined).map((field) => [field, changes[field]]));
	return translating(async () => {
		const comboId = recordId(id);
		const { columns, requirements } = valuesOf(picked, { creating: false });

		return withTransaction(async (tx) => {
			const locked = await tx.$queryRaw`SELECT public_code, name FROM combos WHERE id = ${comboId}::uuid FOR UPDATE`;
			if (locked.length === 0) return null;
			const data = { ...columns };
			if (columns.name !== undefined && columns.name !== locked[0].name) data.slug = slugFor(columns.name, locked[0].public_code);
			if (requirements) {
				await tx.comboCategoryRequirement.deleteMany({ where: { comboId } });
				data.requirements = { create: requirementRows(requirements) };
			}
			return toRecord(await tx.combo.update({ where: { id: comboId }, data, include: { requirements: REQUIREMENT_SELECT } }));
		});
	});
}

/** Delete the combo with this id (its requirements go with it); false when there was none. @throws {InvalidIdError} */
function remove(id) {
	return translating(async () => (await prisma.combo.deleteMany({ where: { id: recordId(id) } })).count === 1);
}

module.exports = { ...publicCodeBackfill(() => prisma.combo), findSellable, findSellableForPricing, list, listNames, listSellable, exists, findById, create, update, remove };
