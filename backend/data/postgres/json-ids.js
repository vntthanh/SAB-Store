/**
 * Ids inside JSON columns (`orders.combo_info`, `order_items_edits.previous_*`).
 *
 * A JSON value has no schema, so its ids cannot be recognised by type. They are
 * recognised by key, the same keys the Mongo restore revives into ObjectIds. A
 * legacy 24-hex id found under one of them is mapped to its uuid, with the same
 * function that mapped the row ids, so an order that points at a product still
 * points at it after a restore of a pre-migration backup.
 */
const { objectIdToUuidV7 } = require('@sab/shared');

const ID_KEYS = new Set(['_id', 'productId', 'comboId', 'orderId']);
const HEX_ID = /^[0-9a-f]{24}$/i;

/** `value` with every legacy hex id under an id key mapped to its uuid; `undefined` members are dropped. */
function mapJsonIds(value) {
	if (Array.isArray(value)) return value.map(mapJsonIds);
	if (value === null || typeof value !== 'object') return value;
	const mapped = {};
	for (const [key, inner] of Object.entries(value)) {
		if (inner === undefined) continue;
		mapped[key] = ID_KEYS.has(key) && typeof inner === 'string' && HEX_ID.test(inner) ? objectIdToUuidV7(inner.toLowerCase()) : mapJsonIds(inner);
	}
	return mapped;
}

module.exports = { mapJsonIds, HEX_ID, ID_KEYS };
