const crypto = require('crypto');
const slugify = require('slugify');

// No 0/O/1/I/L: a code is read aloud and typed from a screenshot. Random on
// purpose, never derived from the ObjectId (its counter part is sequential, so
// neighbouring documents would get guessable codes).
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

/** True for an E11000 raised by the unique index on `publicCode`. */
function isPublicCodeDuplicate(error) {
	if (!error || error.code !== 11000) return false;
	if (error.keyPattern) return Object.prototype.hasOwnProperty.call(error.keyPattern, 'publicCode');
	return /publicCode/.test(String(error.message));
}

/**
 * Run `fn`, running it again when it fails on a publicCode collision. `fn` must
 * build its document (and so draw its code) from scratch on every call: inside
 * a MongoDB transaction a duplicate-key error aborts the whole transaction, so
 * the only recovery is to start over, not to patch the failed write.
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

/**
 * `Model.create(data)` outside a transaction. A caller-supplied `publicCode`
 * (a restore) is tried once: redrawing cannot fix a code that is not random.
 */
function createWithPublicCodeRetry(Model, data, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
	return withPublicCodeRetry(() => Model.create(data), { maxAttempts: data && data.publicCode ? 1 : maxAttempts });
}

/**
 * Give a pre-existing document its code and slug. Goes through the raw driver
 * because `publicCode` is immutable: a Mongoose save or update on a document
 * that lacks it silently drops the value. The `$exists:false` guard makes it
 * safe to re-run and safe against a concurrent writer. Returns true when written.
 */
async function assignMissingPublicCode(Model, doc, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
	return withPublicCodeRetry(async () => {
		const publicCode = module.exports.generatePublicCode();
		const result = await Model.collection.updateOne(
			{ _id: doc._id, publicCode: { $exists: false } },
			{ $set: { publicCode, slug: makeSlug(doc.name, publicCode) } }
		);
		return result.modifiedCount === 1;
	}, { maxAttempts });
}

/**
 * Adds `publicCode` + `slug` to a schema.
 *
 * - The code is drawn only for a NEW document. It is immutable, so an old
 *   document cannot be healed by saving it; `assignMissingPublicCode` does that.
 * - The slug follows the current name. `save()` is covered by the validate hook,
 *   `findOneAndUpdate`/`updateOne` by the query hooks. `updateMany` and
 *   `bulkWrite` are not covered: rename through one of the supported paths.
 */
function publicCodePlugin(schema) {
	schema.add({
		publicCode: {
			type: String,
			unique: true,
			sparse: true,
			immutable: true,
			match: PUBLIC_CODE_PATTERN
		},
		slug: { type: String }
	});

	schema.pre('validate', function () {
		// Looked up on the module object so a test can stub the draw.
		if (this.isNew && !this.publicCode) this.publicCode = module.exports.generatePublicCode();
		if (this.publicCode && (this.isNew || this.isModified('name'))) {
			this.slug = makeSlug(this.name, this.publicCode);
		}
	});

	schema.pre(['findOneAndUpdate', 'updateOne'], async function () {
		const update = this.getUpdate() || {};
		const name = update.$set && update.$set.name !== undefined ? update.$set.name : update.name;
		if (typeof name !== 'string') return;

		const current = await this.model.findOne(this.getFilter()).select('publicCode').session(this.getOptions().session || null).lean();
		if (!current || !current.publicCode) return;
		this.set('slug', makeSlug(name.trim(), current.publicCode));
	});
}

module.exports = {
	PUBLIC_CODE_ALPHABET,
	PUBLIC_CODE_LENGTH,
	PUBLIC_CODE_PATTERN,
	generatePublicCode,
	normalizePublicCode,
	makeSlug,
	isPublicCodeDuplicate,
	withPublicCodeRetry,
	createWithPublicCodeRetry,
	assignMissingPublicCode,
	publicCodePlugin
};
