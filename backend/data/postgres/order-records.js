/**
 * Orders as plain records. The order row and its four child tables (lines,
 * status history, internal notes, item-edit history) are read together and
 * shaped like the JSON the API returns: `_id` is the uuid string, nested arrays
 * come back in `position` order, an optional column that is NULL is an absent
 * key, and `comboInfo` is always present (`null` when the order has no combo).
 */
const IN_ORDER = { orderBy: { position: 'asc' } };

// Fields a read may leave out: the heavy or admin-only ones.
const OMITTABLE_FIELDS = ['internalNotes', 'itemsHistory'];

/** Prisma `include` for a read that leaves out `omit`. @throws {TypeError} */
function includeFor(omit = []) {
	const unknown = omit.find((field) => !OMITTABLE_FIELDS.includes(field));
	if (unknown !== undefined) throw new TypeError(`Cannot omit order field: ${unknown}`);
	return {
		items: IN_ORDER,
		statusHistory: IN_ORDER,
		...(!omit.includes('internalNotes') && { internalNotes: IN_ORDER }),
		...(!omit.includes('itemsHistory') && { itemsEdits: IN_ORDER })
	};
}

// Optional columns: an order that never set one has no such key.
const ABSENT_WHEN_NULL = new Set([
	'orderNumber', 'phoneNumber', 'studentId', 'fullName', 'email', 'additionalNote', 'transactionCode', 'cancelReason', 'createdBy', 'storefrontId'
]);

const present = (entries) => Object.fromEntries(entries.filter(([, value]) => value !== null));

const itemRecord = (item) => ({
	_id: item.id,
	productId: item.productId,
	productName: item.productName,
	price: item.price,
	quantity: item.quantity,
	fromCombo: item.fromCombo,
	comboId: item.comboId,
	comboName: item.comboName,
	// Absent on a line of a product deleted before variants existed, and the label on a default variant.
	...present([['variantId', item.variantId], ['variantLabel', item.variantLabel]])
});

const historyRecord = (entry) => ({
	_id: entry.id,
	status: entry.status,
	updatedBy: entry.updatedBy,
	updatedAt: entry.updatedAt,
	...present([['transactionCode', entry.transactionCode], ['cancelReason', entry.cancelReason], ['note', entry.note]])
});

const noteRecord = (note) => ({ note: note.note, by: note.by, at: note.at });

const editRecord = (edit) => ({
	previousItems: edit.previousItems,
	previousComboInfo: edit.previousComboInfo,
	editedBy: edit.editedBy,
	editedAt: edit.editedAt,
	reason: edit.reason
});

/** A row loaded with `includeFor(...)` as a plain record. */
function toRecord(row) {
	const { id, items, statusHistory, internalNotes, itemsEdits, ...columns } = row;
	const record = { _id: id };
	for (const [key, value] of Object.entries(columns)) {
		if (value === null && ABSENT_WHEN_NULL.has(key)) continue;
		record[key] = value;
	}
	record.items = items.map(itemRecord);
	record.statusHistory = statusHistory.map(historyRecord);
	if (internalNotes) record.internalNotes = internalNotes.map(noteRecord);
	if (itemsEdits) record.itemsHistory = itemsEdits.map(editRecord);
	return record;
}

module.exports = { includeFor, toRecord, itemRecord };
