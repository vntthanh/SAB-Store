/**
 * Better Auth's collections (user, account, session, verification, jwks) as
 * Postgres rows. Login material is copied byte for byte: password hashes,
 * session tokens and the encrypted JWKS keys must keep working under the same
 * secret, so nothing here re-hashes or re-encrypts.
 *
 * Every id, and every reference to a user, goes through objectIdToUuidV7, the
 * map the store tables use. A reference may be stored as an ObjectId or as its
 * hex string (the old Account model typed `userId` as a string); both are taken.
 * A credential account's `accountId` is its user's id, so it is mapped too;
 * another provider's `accountId` is that provider's own id and is kept.
 *
 * Nothing is coerced silently. A field outside the lists below, a missing
 * required value, a reference to no user or a value that would break a Postgres
 * unique index is a problem, and any problem stops the run. Problems name the
 * collection, the id and the field, never a value: these rows hold emails,
 * hashes and tokens.
 *
 * Rows that can no longer be used are dropped and counted: expired sessions and
 * expired verification values. Usernames are stored lowercase because the
 * username plugin lowercases on every lookup; a capitalised one is lowercased
 * and the original kept as `displayUsername` when that is empty.
 */
const crypto = require('crypto');
const { objectIdToUuidV7 } = require('@sab/shared');

const FIELDS = {
	user: ['_id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt', 'username', 'displayUsername', 'role', 'banned', 'banReason', 'banExpires'],
	account: ['_id', 'accountId', 'providerId', 'userId', 'accessToken', 'refreshToken', 'idToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'scope', 'password', 'createdAt', 'updatedAt'],
	session: ['_id', 'expiresAt', 'token', 'createdAt', 'updatedAt', 'ipAddress', 'userAgent', 'userId', 'impersonatedBy'],
	verification: ['_id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt'],
	jwks: ['_id', 'publicKey', 'privateKey', 'createdAt', 'expiresAt', 'alg', 'crv']
};
const DATE_FIELDS = new Set(['createdAt', 'updatedAt', 'expiresAt', 'banExpires', 'accessTokenExpiresAt', 'refreshTokenExpiresAt']);
const BOOLEAN_FIELDS = new Set(['emailVerified', 'banned']);
// Stored as an ObjectId or as its hex string; resolved against the users later.
const REF_FIELDS = new Set(['userId', 'impersonatedBy', 'accountId']);
const ROLES = new Set(['admin', 'seller', 'user']);
const HEX_ID = /^[0-9a-f]{24}$/i;

/** The 24-hex form of an ObjectId or of its string; null for anything else. */
function hexOf(value) {
	if (value && value._bsontype === 'ObjectId') return value.toHexString();
	if (typeof value === 'string' && HEX_ID.test(value)) return value.toLowerCase();
	return null;
}

const sha256 = (values) => crypto.createHash('sha256').update([...values].sort().join('\n')).digest('hex');

/**
 * Why `value` cannot go into column `key`, or null. Text columns must hold
 * strings: anything else would reach Prisma, whose validation error echoes the
 * whole row. References are checked against the users afterwards.
 */
function typeProblem(key, value) {
	if (DATE_FIELDS.has(key)) return value instanceof Date ? null : 'phải là ngày giờ';
	if (BOOLEAN_FIELDS.has(key)) return typeof value === 'boolean' ? null : 'phải là true/false';
	if (REF_FIELDS.has(key)) return null;
	return typeof value === 'string' ? null : 'phải là chuỗi';
}

/**
 * One collection's documents, checked field by field, as plain objects keyed
 * like the Postgres columns (the id under `_hex` until it is mapped). Problems
 * go into `problems`.
 */
function checkedDocs(collection, docs, problems) {
	const allowed = new Set(FIELDS[collection]);
	const out = [];
	for (const doc of docs) {
		const hex = hexOf(doc._id);
		const where = `${collection} ${hex ?? '(id không hợp lệ)'}`;
		if (!hex) {
			problems.push(`${where}: _id không phải ObjectId`);
			continue;
		}
		const row = { _hex: hex };
		for (const [key, value] of Object.entries(doc)) {
			// __v: Mongoose's version key, on documents written through a model.
			if (key === '_id' || key === '__v') continue;
			if (!allowed.has(key)) {
				problems.push(`${where}: trường "${key}" không được nhận diện`);
				continue;
			}
			if (value === null || value === undefined) continue;
			const wrongType = typeProblem(key, value);
			if (wrongType) problems.push(`${where}.${key} ${wrongType}`);
			else row[key] = value;
		}
		out.push({ row, where });
	}
	return out;
}

function requireText(row, where, keys, problems) {
	for (const key of keys) {
		if (typeof row[key] !== 'string' || row[key] === '') problems.push(`${where}: thiếu "${key}"`);
	}
}

/** `updatedAt` falls back to `createdAt`, then to `now`: on session and account the column has no default. */
const stamped = ({ _hex, ...row }, now) => ({
	...row,
	id: objectIdToUuidV7(_hex),
	createdAt: row.createdAt ?? now,
	updatedAt: row.updatedAt ?? row.createdAt ?? now
});

function flagDuplicates(entries, keyOf, label, problems) {
	const seen = new Map();
	for (const { row, where } of entries) {
		const key = keyOf(row);
		if (key === undefined) continue;
		if (seen.has(key)) problems.push(`${where}: trùng ${label} với ${seen.get(key)}`);
		else seen.set(key, where);
	}
}

function mapUsers(docs, now, problems, report) {
	const entries = checkedDocs('user', docs, problems);
	for (const { row, where } of entries) {
		requireText(row, where, ['name', 'email', 'username'], problems);
		if (typeof row.email === 'string' && row.email !== row.email.trim().toLowerCase()) {
			problems.push(`${where}: email không ở dạng chữ thường đã cắt khoảng trắng`);
		}
		if (row.role !== undefined && !ROLES.has(row.role)) problems.push(`${where}: role không hợp lệ`);
		if (typeof row.username === 'string' && row.username !== row.username.toLowerCase()) {
			if (row.displayUsername === undefined) row.displayUsername = row.username;
			row.username = row.username.toLowerCase();
			report.lowercasedUsernames += 1;
		}
		if (row.banned === true) {
			report.bannedUsers += 1;
			if (row.banExpires && row.banExpires <= now) report.expiredBans += 1;
		}
	}
	flagDuplicates(entries, (row) => row.email, 'email', problems);
	flagDuplicates(entries, (row) => row.username, 'username (không phân biệt hoa thường)', problems);
	return entries.map(({ row }) => ({ emailVerified: false, ...stamped(row, now) }));
}

/** The uuid of the user `value` points at, or undefined after recording a problem. */
function userRef(value, users, where, field, problems) {
	const hex = hexOf(value);
	if (!hex) {
		problems.push(`${where}.${field} không phải mã người dùng`);
		return undefined;
	}
	if (!users.has(hex)) {
		problems.push(`${where}.${field} trỏ tới người dùng không tồn tại`);
		return undefined;
	}
	return objectIdToUuidV7(hex);
}

function mapAccounts(docs, users, now, problems) {
	const entries = checkedDocs('account', docs, problems);
	for (const { row, where } of entries) {
		requireText(row, where, ['providerId'], problems);
		const userHex = hexOf(row.userId);
		row.userId = userRef(row.userId, users, where, 'userId', problems);
		if (row.accountId === undefined) {
			problems.push(`${where}: thiếu "accountId"`);
		} else if (row.providerId === 'credential') {
			// Without a hash the user could never sign in again; the old model required one.
			if (typeof row.password !== 'string' || row.password === '') problems.push(`${where}: tài khoản credential thiếu mật khẩu`);
			if (hexOf(row.accountId) !== userHex) problems.push(`${where}: accountId của tài khoản credential khác userId`);
			else row.accountId = row.userId;
		} else if (typeof row.accountId !== 'string') {
			problems.push(`${where}: accountId phải là chuỗi`);
		}
	}
	flagDuplicates(entries, (row) => (row.accountId === undefined ? undefined : `${row.providerId}\u0000${row.accountId}`), '(providerId, accountId)', problems);
	return entries.map(({ row }) => stamped(row, now));
}

function mapSessions(docs, users, now, problems, report) {
	const live = checkedDocs('session', docs, problems).filter(({ row }) => {
		const expired = row.expiresAt instanceof Date && row.expiresAt <= now;
		if (expired) report.droppedExpiredSessions += 1;
		return !expired;
	});
	for (const { row, where } of live) {
		requireText(row, where, ['token'], problems);
		if (!(row.expiresAt instanceof Date)) problems.push(`${where}: thiếu "expiresAt"`);
		row.userId = userRef(row.userId, users, where, 'userId', problems);
		if (row.impersonatedBy !== undefined) row.impersonatedBy = userRef(row.impersonatedBy, users, where, 'impersonatedBy', problems);
	}
	flagDuplicates(live, (row) => row.token, 'token', problems);
	return live.map(({ row }) => stamped(row, now));
}

function mapVerifications(docs, now, problems, report) {
	const live = checkedDocs('verification', docs, problems).filter(({ row }) => {
		const expired = row.expiresAt instanceof Date && row.expiresAt <= now;
		if (expired) report.droppedExpiredVerifications += 1;
		return !expired;
	});
	for (const { row, where } of live) {
		requireText(row, where, ['identifier', 'value'], problems);
		if (!(row.expiresAt instanceof Date)) problems.push(`${where}: thiếu "expiresAt"`);
	}
	return live.map(({ row }) => stamped(row, now));
}

function mapJwks(docs, now, problems) {
	const entries = checkedDocs('jwks', docs, problems);
	for (const { row, where } of entries) requireText(row, where, ['publicKey', 'privateKey'], problems);
	// No updatedAt column; createdAt is kept because the newest key is the one in use.
	return entries.map(({ row: { _hex, ...row } }) => ({ ...row, id: objectIdToUuidV7(_hex), createdAt: row.createdAt ?? now }));
}

/**
 * @param {Record<string, object[]>} auth raw documents per collection (readSource().auth)
 * @param {Date} now expiry cut-off and fallback timestamp
 * @returns {{rows: Record<string, object[]>, problems: string[], report: object, passwordDigest: string}}
 *   `report` holds counts only; `passwordDigest` (a hash over the set of password
 *   hashes) is compared with the rows read back and kept out of every output
 */
function mapAuth(auth, now) {
	const problems = [];
	const report = { lowercasedUsernames: 0, bannedUsers: 0, expiredBans: 0, droppedExpiredSessions: 0, droppedExpiredVerifications: 0 };

	const user = mapUsers(auth.user, now, problems, report);
	const users = new Set(auth.user.map((doc) => hexOf(doc._id)).filter(Boolean));
	const rows = {
		user,
		account: mapAccounts(auth.account, users, now, problems),
		session: mapSessions(auth.session, users, now, problems, report),
		verification: mapVerifications(auth.verification, now, problems, report),
		jwks: mapJwks(auth.jwks, now, problems)
	};
	// From the raw documents, not the mapped rows, so a mapping that loses a hash shows.
	const passwordDigest = sha256(auth.account.map((doc) => doc.password).filter((hash) => typeof hash === 'string' && hash !== ''));
	return { rows, problems, report, passwordDigest };
}

module.exports = { mapAuth, sha256 };
