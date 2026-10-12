/**
 * Which data backend this run exercises, for the few tests that only make sense
 * on one of them. A test skipped on Postgres states why in a comment beside the
 * `skipIf`, and the reason is always that it drives a Mongoose model or a raw
 * MongoDB document. Login-table reads are not a reason: tests/helpers/db.js
 * serves them from either store.
 */
const POSTGRES = process.env.DATA_BACKEND === 'postgres';

module.exports = { POSTGRES };
