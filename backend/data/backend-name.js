/**
 * The one reading of `DATA_BACKEND`. The index picks repositories with it and
 * the id rules pick the id shape with it, so an unknown value stops the process
 * here, at require time, rather than falling back to another store.
 *
 * `postgres` is the default. `mongo` stays selectable as the rollback store.
 */
const BACKEND_NAMES = ['mongo', 'postgres'];

const backendName = process.env.DATA_BACKEND || 'postgres';
if (!BACKEND_NAMES.includes(backendName)) {
	throw new Error(`Unknown DATA_BACKEND "${backendName}"; expected one of: ${BACKEND_NAMES.join(', ')}`);
}

module.exports = { backendName };
