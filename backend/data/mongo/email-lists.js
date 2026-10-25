/**
 * Email lists need the PostgreSQL store. This rollback store holds none: reads
 * report an empty set and every write is refused rather than silently dropped.
 * Same precedent as mail-settings.js.
 */
const { buildPaginationMeta } = require('@sab/shared');

async function unsupported() {
	throw new Error('not supported on the rollback store');
}

async function list() {
	return [];
}

async function findById() {
	return null;
}

async function entriesPage(_listId, { page, limit }) {
	return { data: [], meta: buildPaginationMeta(0, { page, limit }) };
}

module.exports = {
	list,
	findById,
	entriesPage,
	create: unsupported,
	update: unsupported,
	remove: unsupported,
	addEntries: unsupported,
	removeEntry: unsupported,
	clear: unsupported
};
