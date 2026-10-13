/**
 * Encryption at rest for secrets the admin enters in the UI (the SMTP password).
 * AES-256-GCM; the key is derived from JWT_SECRET with scrypt, so there is no
 * second secret to deploy, and rotating JWT_SECRET makes every stored envelope
 * undecryptable: callers read that as "not configured" and the admin re-enters it.
 * Format: `v1:<iv b64>:<tag b64>:<ciphertext b64>`.
 */
const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('crypto');

const SCRYPT_SALT = 'sab-store-secret-box-v1';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION = 'v1';

// scrypt is slow and synchronous; derive once per secret value.
let derived = null;

function deriveKey() {
	const secret = process.env.JWT_SECRET;
	if (!secret) throw new Error('JWT_SECRET is not set');
	if (derived?.secret !== secret) {
		derived = { secret, key: scryptSync(secret, SCRYPT_SALT, KEY_LENGTH) };
	}
	return derived.key;
}

/** @param {string} plaintext */
function encryptSecret(plaintext) {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [VERSION, iv, tag, ciphertext].map((part) => (typeof part === 'string' ? part : part.toString('base64'))).join(':');
}

/**
 * The plain text of an envelope from `encryptSecret`, or null when it is malformed,
 * tampered with, or sealed under another JWT_SECRET.
 *
 * @param {string} envelope
 * @returns {string|null}
 */
function decryptSecret(envelope) {
	try {
		const parts = String(envelope).split(':');
		if (parts.length !== 4 || parts[0] !== VERSION) return null;
		const [iv, tag, data] = parts.slice(1).map((part) => Buffer.from(part, 'base64'));
		// Pinned: Node otherwise accepts a truncated tag, which weakens tamper detection.
		if (tag.length !== TAG_LENGTH) return null;
		const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv, { authTagLength: TAG_LENGTH });
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
	} catch {
		return null;
	}
}

module.exports = { encryptSecret, decryptSecret };
