const crypto = require('crypto');
const slugify = require('slugify');
const { isDuplicateKeyOn } = require('../data/errors');

// No 0/O/1/I/L: a code is read aloud and typed from a screenshot. Random on
// purpose, never derived from a sequential id, which would make neighbouring
// records' codes guessable.
const PUBLIC_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PUBLIC_CODE_LENGTH = 8;
const PUBLIC_CODE_PATTERN = new RegExp(`^[${PUBLIC_CODE_ALPHABET}]{${PUBLIC_CODE_LENGTH}}$`);
const SLUG_MAX_LENGTH = 80;
const DEFAULT_MAX_ATTEMPTS = 5;

function generatePublicCode() {
	let code = '';
	for (let i = 0; i < PUBLIC_CODE_LENGTH; i++) {
		code += PUBLIC_CODE_ALPHABET[crypto.randomInt(PUBLIC_CODE_ALPHABET.length)];
	}
	return code;
}

/** Canonical code for a user-supplied value, or null. Never touches the database. */
function normalizePublicCode(input) {
	if (typeof input !== 'string') return null;
	// ASCII-only before upper-casing: 'ſ'.toUpperCase() is 'S', which would let
	// many distinct URLs (and cache keys) resolve to one product.
	const trimmed = input.trim();
	if (!/^[A-Za-z0-9]+$/.test(trimmed)) return null;
	const code = trimmed.toUpperCase();
	return PUBLIC_CODE_PATTERN.test(code) ? code : null;
}

function makeSlug(name, code) {
	const slug = slugify(typeof name === 'string' ? name : '', { lower: true, strict: true, locale: 'vi' })
		.slice(0, SLUG_MAX_LENGTH)
		.replace(/-+$/, '');
	return slug || String(code).toLowerCase();
}

/** True for a unique-constraint violation on `publicCode`. */
function isPublicCodeDuplicate(error) {
	return isDuplicateKeyOn(error, 'publicCode');
}

/**
 * Run `fn`, running it again when it fails on a publicCode collision. `fn` must
 * build its row (and so draw its code) from scratch on every call: inside a
 * transaction a unique violation aborts the whole transaction, so the only
 * recovery is to start over, not to patch the failed write.
 */
async function withPublicCodeRetry(fn, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (!isPublicCodeDuplicate(error) || attempt >= maxAttempts) throw error;
		}
	}
}

module.exports = {
	PUBLIC_CODE_PATTERN,
	generatePublicCode,
	normalizePublicCode,
	makeSlug,
	isPublicCodeDuplicate,
	withPublicCodeRetry
};
