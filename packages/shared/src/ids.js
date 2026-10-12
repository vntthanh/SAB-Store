// Record ids are UUIDv7. Rows that predate the move to PostgreSQL carry 24-hex
// ObjectIds, and those ids still live in browsers (carts), idempotency keys,
// queue jobs, JSON snapshots and old backup files. objectIdToUuidV7 translates
// them, and does so identically on the server and in the browser.
//
// Bit layout of the UUID produced for an ObjectId (12 bytes: 4-byte seconds
// timestamp, then 8 bytes that are random per process plus a counter):
//
//   bits 127..80  unix_ts_ms  = ObjectId seconds * 1000   (48 bits)
//   bits  79..76  version     = 0b0111                    ( 4 bits)
//   bits  75..64  rand_a      = top 12 of the 64 trailing ObjectId bits
//   bits  63..62  variant     = 0b10                      ( 2 bits)
//   bits  61..10  rand_b high = low 52 of the 64 trailing ObjectId bits
//   bits   9..0   rand_b low  = 0                         (10 bits)
//
// All 64 trailing bits survive, so the map is injective and invertible. The
// timestamp comes first and the trailing bits keep their order, so ObjectIds
// created in time order map to UUIDs that sort in the same order. The trailing
// zero bits are deliberate: the free space is 74 bits but only 64 are needed,
// and zeroing the tail keeps the inverse exact.

const OBJECT_ID = /^[0-9a-f]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V7_VARIANT_1 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const LOW_52 = (1n << 52n) - 1n;
const ZERO_TAIL_BITS = 10n;
const VARIANT_10 = 0b10n << 62n;

/**
 * Maps a 24-hex ObjectId to a UUIDv7, deterministically and injectively.
 * Upper-case input is lowercased; anything else that is not 24 hex digits throws.
 */
export function objectIdToUuidV7(objectId) {
	const hex = typeof objectId === 'string' ? objectId.toLowerCase() : '';
	if (!OBJECT_ID.test(hex)) {
		throw new TypeError('objectIdToUuidV7 needs a 24-character hexadecimal ObjectId');
	}
	const unixTsMs = parseInt(hex.slice(0, 8), 16) * 1000;
	const trailing = BigInt(`0x${hex.slice(8)}`);
	const randA = trailing >> 52n;
	const lowHalf = VARIANT_10 | ((trailing & LOW_52) << ZERO_TAIL_BITS);

	const ts = unixTsMs.toString(16).padStart(12, '0');
	const tail = lowHalf.toString(16).padStart(16, '0');
	return [
		ts.slice(0, 8),
		ts.slice(8),
		`7${randA.toString(16).padStart(3, '0')}`,
		tail.slice(0, 4),
		tail.slice(4),
	].join('-');
}

/**
 * Inverse of objectIdToUuidV7, for tests and debugging. Throws for a UUID that
 * the map cannot have produced (another version or variant, a timestamp that is
 * not whole seconds, or non-zero tail bits), so a genuine v7 id is never
 * silently mistaken for a migrated ObjectId.
 */
export function uuidV7ToObjectId(uuid) {
	const hex = typeof uuid === 'string' ? uuid.toLowerCase() : '';
	if (!V7_VARIANT_1.test(hex)) {
		throw new TypeError('uuidV7ToObjectId needs a canonical UUIDv7');
	}
	const compact = hex.replace(/-/g, '');
	const unixTsMs = parseInt(compact.slice(0, 12), 16);
	const lowHalf = BigInt(`0x${compact.slice(16)}`);
	if (unixTsMs % 1000 !== 0 || unixTsMs / 1000 > 0xffffffff || (lowHalf & ((1n << ZERO_TAIL_BITS) - 1n)) !== 0n) {
		throw new TypeError('This UUIDv7 was not derived from an ObjectId');
	}
	const randA = BigInt(`0x${compact.slice(13, 16)}`);
	const low52 = (lowHalf >> ZERO_TAIL_BITS) & LOW_52;
	const trailing = (randA << 52n) | low52;
	return (unixTsMs / 1000).toString(16).padStart(8, '0') + trailing.toString(16).padStart(16, '0');
}

/** A UUID in canonical lowercase form, any RFC 9562 version. */
export const isUuid = (value) => typeof value === 'string' && UUID.test(value);

/**
 * A record id: a UUID, or a legacy 24-hex ObjectId while old clients and
 * backups are still around. Callers that accept the legacy form map it with
 * objectIdToUuidV7 before touching the database.
 */
export const isRecordId = (value) =>
	isUuid(value) || (typeof value === 'string' && OBJECT_ID.test(value.toLowerCase()));
