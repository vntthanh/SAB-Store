/**
 * Combo reads for pricing and the public storefront. A `tx` is the transaction
 * from `withTransaction`.
 */
const Combo = require('../../models/Combo');
const { comboSellableFilter, COMBO_SELLABLE_SORT } = require('./sellable');
const { withStringId, toRecord } = require('./records');
const { translating } = require('./errors');
const { createWithPublicCodeRetry } = require('../../utils/public-code');

// The only fields an edit may change.
const EDITABLE_FIELDS = ['name', 'description', 'price', 'categoryRequirements', 'priority', 'isActive', 'salesChannel'];

const sellableFind = (channel, filter) => Combo.find(comboSellableFilter(channel, filter)).sort(COMBO_SELLABLE_SORT);

/**
 * Combos that may discount an order on `channel`, offered order first
 * (priority, then newest), as plain records, optionally only the one with this
 * `publicCode`. Nested `categoryRequirements[]._id` stay the store's native ids
 * and records carry `__v`; callers must not read either. Validates `channel`
 * synchronously, like `products.findSellable`.
 *
 * @param {'online'|'offline'} channel
 * @param {{publicCode?: string}} [options]
 * @returns {Promise<object[]>}
 * @throws {TypeError} channel missing or unknown
 */
function findSellable(channel, { publicCode } = {}) {
	const filter = publicCode === undefined ? {} : { publicCode };
	return sellableFind(channel, filter).lean().then((found) => found.map(withStringId));
}

/**
 * The combos pricing may apply on `channel`, in offered order. Records keep the
 * store's own `_id`: pricing copies it into the order's combo lines.
 *
 * @param {'online'|'offline'} channel
 * @param {string[]} fields
 * @param {object|null} [tx]
 * @returns {Promise<object[]>}
 */
async function findSellableForPricing(channel, fields, tx) {
	const query = sellableFind(channel).select(fields.join(' ')).lean();
	return tx ? query.session(tx) : query;
}

/**
 * Every combo, offered order first, optionally only the active or only the
 * stopped ones.
 *
 * @param {{active?: boolean}} [options]
 * @returns {Promise<object[]>}
 */
async function list({ active } = {}) {
	const filter = active === undefined ? {} : { isActive: active };
	const found = await Combo.find(filter).sort({ priority: -1, createdAt: -1 }).lean();
	return found.map(withStringId);
}

/**
 * The combos that may discount an order on `channel`, offered order first, as
 * complete records with the schema defaults applied.
 *
 * @param {'online'|'offline'} channel
 * @returns {Promise<object[]>}
 * @throws {TypeError} channel missing or unknown
 */
async function listSellable(channel) {
	return (await sellableFind(channel)).map(toRecord);
}

/** The name of every combo. */
async function listNames() {
	const found = await Combo.find({}, { name: 1 }).lean();
	return found.map((combo) => combo.name);
}

/** True when a combo with this id exists. */
async function exists(id) {
	return Boolean(await Combo.exists({ _id: id }));
}

/** The combo with this id, or null. @throws {InvalidIdError} */
function findById(id) {
	return translating(async () => {
		const combo = await Combo.findById(id);
		return combo ? toRecord(combo) : null;
	});
}

/**
 * Insert a combo, drawing a new public code when one collides. A `publicCode`
 * in `data` (a restore) is tried once.
 *
 * @param {object} data
 * @returns {Promise<object>}
 * @throws {RecordValidationError|DuplicateKeyError|InvalidIdError}
 */
function create(data) {
	return translating(async () => toRecord(await createWithPublicCodeRetry(Combo, data)));
}

/**
 * Apply the editable fields of `changes` that are not undefined and return the
 * combo as stored, or null when it does not exist. Saved as a document so the
 * schema validates the combo as a whole.
 *
 * @param {string} id
 * @param {object} changes
 * @returns {Promise<object|null>}
 * @throws {RecordValidationError|InvalidIdError}
 */
function update(id, changes) {
	return translating(async () => {
		const combo = await Combo.findById(id);
		if (!combo) return null;
		for (const field of EDITABLE_FIELDS) {
			if (changes[field] !== undefined) combo[field] = changes[field];
		}
		await combo.save();
		return toRecord(combo);
	});
}

/** Delete the combo with this id; false when there was none. @throws {InvalidIdError} */
function remove(id) {
	return translating(async () => Boolean(await Combo.findByIdAndDelete(id)));
}

module.exports = { findSellable, findSellableForPricing, list, listNames, listSellable, exists, findById, create, update, remove };
