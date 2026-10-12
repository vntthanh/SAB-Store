/**
 * Which data backend this run exercises, for the few tests that only make sense
 * on one of them. A test skipped on Postgres states why in a comment beside the
 * `skipIf`, and the reason is always one of these: it drives a Mongoose model or
 * a raw MongoDB document, or it covers the bootstrap repository (which waits for
 * the auth conversion). Login-table reads are not a reason: tests/helpers/db.js
 * keeps serving them from MongoDB on both backends.
 */
const POSTGRES = process.env.DATA_BACKEND === 'postgres';

module.exports = { POSTGRES };
