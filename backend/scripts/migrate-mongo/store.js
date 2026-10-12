/**
 * The store's business collections as a snapshot (data/snapshot.js), the form
 * the Postgres restore writes. Going through the snapshot means the migration
 * gets the restore's guarantees for free: an unrecognised field anywhere stops
 * the run, ids are mapped to uuids by key, and movements keep their order.
 *
 * Before validation, the gaps that old documents may have and the NOT NULL
 * columns cannot hold are repaired, each by the rule the application itself
 * used, and counted:
 * - `updatedAt` missing: the document's `createdAt`;
 * - `stockDeducted` missing on an order: `isDirectSale` (a direct sale took its
 *   stock at once; an online order did not until it was paid), except on a
 *   cancelled order, whose units are back. Plain `false` would make a later
 *   cancel of a direct sale give no stock back;
 * - `statusUpdatedAt` missing on an order: the time of its last status change,
 *   or its `createdAt` when it has no history.
 * A product or combo without a public code is given one by the restore; it is
 * counted here.
 *
 * Movements are put in ledger order, (createdAt, _id), the order the Mongo ledger
 * applies them in: the restore numbers them (`seq`) in the order given, and by
 * _id alone two pending movements written by different processes in the same
 * second could swap.
 */
const { validateSnapshot, buildMetadata } = require('../../data/snapshot');
// The Mongo export's own conversion (ObjectId -> hex, Date -> ISO), so the loader
// hands the restore exactly the wire form an admin backup file has.
const { toWire } = require('../../data/mongo/data-snapshot');

// ISO strings (all from toISOString) and 24-hex ids both sort correctly as text.
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const inLedgerOrder = (a, b) => byText(a.createdAt ?? '', b.createdAt ?? '') || byText(a._id, b._id);

function withUpdatedAt(doc, repairs) {
	if (doc.updatedAt !== undefined || doc.createdAt === undefined) return doc;
	repairs.updatedAt += 1;
	return { ...doc, updatedAt: doc.createdAt };
}

function repairOrder(order, repairs) {
	const out = { ...order };
	if (out.stockDeducted === undefined) {
		out.stockDeducted = out.isDirectSale === true && out.status !== 'cancelled';
		repairs.stockDeducted += 1;
	}
	if (out.statusUpdatedAt === undefined) {
		const history = Array.isArray(out.statusHistory) ? out.statusHistory : [];
		const last = history.length > 0 ? history[history.length - 1].updatedAt : undefined;
		const at = last ?? out.createdAt;
		if (at !== undefined) {
			out.statusUpdatedAt = at;
			repairs.statusUpdatedAt += 1;
		}
	}
	return out;
}

/**
 * @param {Record<string, object[]>} store raw documents per snapshot section (readSource().store)
 * @param {Date} now
 * @returns {{data: Record<string, object[]>, problems: string[], repairs: Record<string, number>}}
 */
function buildStoreSnapshot(store, now) {
	const repairs = { updatedAt: 0, stockDeducted: 0, statusUpdatedAt: 0, publicCode: 0 };
	const stamped = (docs) => docs.map((doc) => withUpdatedAt(toWire(doc), repairs));

	const data = {
		products: stamped(store.products),
		combos: stamped(store.combos),
		orders: stamped(store.orders).map((order) => repairOrder(order, repairs)),
		stockMovements: store.stockMovements.map(toWire).sort(inLedgerOrder),
		settings: stamped(store.settings)
	};
	repairs.publicCode = [...data.products, ...data.combos].filter((doc) => !doc.publicCode).length;

	return { data, problems: validateSnapshot(buildMetadata(data, now), data), repairs };
}

module.exports = { buildStoreSnapshot };
