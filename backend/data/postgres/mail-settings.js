/**
 * The SMTP account used for order mail: a single row in its own table, so the
 * data snapshot (which lists its tables explicitly) never carries the credential.
 * The password is stored and returned as the encrypted envelope of
 * lib/secret-box.js (`passEncrypted`); this file never sees the plain text.
 *
 * Rules (lengths, required, format) belong to the caller: the admin route
 * validates against the shared schema before anything reaches `upsertConfig`.
 */
const { prisma } = require('../../lib/prisma');

const MAIL_SETTINGS_KEY = 'smtp';

const WRITABLE_FIELDS = [
	'enabled', 'host', 'port', 'secure', 'username', 'passEncrypted',
	'fromName', 'fromAddress', 'notifyOrderCreated', 'notifyStatusChanged', 'updatedBy'
];

function toRecord(row) {
	const { id, key, ...rest } = row;
	return { _id: id, ...rest };
}

/** The row as a plain record, or null when mail was never configured. */
async function findConfig() {
	const row = await prisma.mailSettings.findUnique({ where: { key: MAIL_SETTINGS_KEY } });
	return row ? toRecord(row) : null;
}

/**
 * Creates the row or updates the fields given; a field left out keeps its stored
 * value (the first save must carry every required one, `passEncrypted` included).
 *
 * @param {object} fields
 * @returns {Promise<object>}
 */
async function upsertConfig(fields) {
	const values = Object.fromEntries(
		WRITABLE_FIELDS.filter((name) => fields[name] !== undefined).map((name) => [name, fields[name]])
	);
	// Prisma validates an upsert's create branch even when the row exists, so a save
	// that keeps the stored password (no passEncrypted) must be a plain update.
	const where = { key: MAIL_SETTINGS_KEY };
	const row = values.passEncrypted === undefined
		? await prisma.mailSettings.update({ where, data: values })
		: await prisma.mailSettings.upsert({ where, create: { ...where, ...values }, update: values });
	return toRecord(row);
}

module.exports = { findConfig, upsertConfig };
