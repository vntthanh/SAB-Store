/** Every table the migration writes, parents and children. */
const TARGET_TABLES = [
	'user', 'account', 'session', 'verification', 'jwks',
	'products', 'combos', 'combo_category_requirements',
	'orders', 'order_items', 'order_status_history', 'order_internal_notes', 'order_items_edits',
	'stock_movements', 'settings'
];

/**
 * Rows per target table. `client` is a transaction or the Prisma client. The
 * table names are the fixed list above, never input, hence the raw query.
 *
 * @returns {Promise<Record<string, number>>}
 */
async function countTables(client) {
	const counts = {};
	for (const table of TARGET_TABLES) {
		const [{ n }] = await client.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}"`);
		counts[table] = n;
	}
	return counts;
}

module.exports = { TARGET_TABLES, countTables };
