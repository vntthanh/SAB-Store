/**
 * Mail settings need the PostgreSQL store. This rollback store has no table for
 * them: reading reports "never configured", so order mail stays off, and a write
 * is refused rather than silently dropped.
 */

/** @returns {Promise<null>} */
async function findConfig() {
	return null;
}

async function upsertConfig() {
	throw new Error('Mail settings need the PostgreSQL data store; the MongoDB store cannot hold them');
}

module.exports = { findConfig, upsertConfig };
