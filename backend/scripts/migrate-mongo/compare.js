/**
 * Proves the business data survived the load: every field of every source
 * record, read back from Postgres (`dataSnapshot.exportAll`), must be equal.
 *
 * The expected record is the source record with only the changes the migration
 * is meant to make: ids mapped to uuids by key (the keys the restore maps, plus
 * the segments of an idempotency key), `__v` gone, and an empty phone number
 * gone (the column's CHECK refuses ''). It is built from the source, not from
 * the rows the restore wrote, so a field the restore drops or alters shows up.
 *
 * The comparison runs one way. A key only Postgres has is a column default (a
 * sales channel, a public code given to an old product) and is allowed; a key
 * the source has must come back with the same value. Null and absent count as
 * the same. Messages carry the section, the source id and the path, never a
 * value.
 */
const { objectIdToUuidV7 } = require('@sab/shared');
// The restore's own list of id keys, so the two cannot disagree on which keys hold
// ids; the mapping below is deliberately not the restore's code.
const { ID_KEYS, HEX_ID } = require('../../data/postgres/json-ids');
const MAX_PROBLEMS = 50;

const mapHex = (value) => (typeof value === 'string' && HEX_ID.test(value) ? objectIdToUuidV7(value) : value);

function mapIds(value) {
	if (Array.isArray(value)) return value.map(mapIds);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, ID_KEYS.has(key) ? mapHex(inner) : mapIds(inner)]));
}

function expectedRecord(section, doc) {
	const { __v, ...rest } = doc;
	const record = mapIds(rest);
	if (section === 'orders') {
		if (record.createdBy !== undefined) record.createdBy = mapHex(record.createdBy);
		if (record.phoneNumber === '') delete record.phoneNumber;
	}
	if (section === 'stockMovements' && typeof record.idempotencyKey === 'string') {
		record.idempotencyKey = record.idempotencyKey.split(':').map(mapHex).join(':');
	}
	return record;
}

const isNothing = (value) => value === null || value === undefined;

function diff(expected, actual, path, out) {
	if (isNothing(expected)) {
		if (!isNothing(actual)) out.push(path);
		return;
	}
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || actual.length !== expected.length) {
			out.push(path);
			return;
		}
		expected.forEach((item, index) => diff(item, actual[index], `${path}[${index}]`, out));
		return;
	}
	if (typeof expected === 'object') {
		if (isNothing(actual) || typeof actual !== 'object' || Array.isArray(actual)) {
			out.push(path);
			return;
		}
		for (const [key, inner] of Object.entries(expected)) diff(inner, actual[key], path ? `${path}.${key}` : key, out);
		return;
	}
	if (expected !== actual) out.push(path);
}

/**
 * @param {Record<string, object[]>} source wire-form sections the load was given
 * @param {Record<string, object[]>} exported `dataSnapshot.exportAll()` after the load
 * @returns {string[]} one line per field that did not come back; empty when lossless
 */
function compareStore(source, exported) {
	const problems = [];
	for (const [section, docs] of Object.entries(source)) {
		const byId = new Map(exported[section].map((row) => [row._id, row]));
		for (const doc of docs) {
			const expected = expectedRecord(section, doc);
			const actual = byId.get(expected._id);
			const paths = [];
			if (!actual) paths.push('(không có bản ghi)');
			else diff(expected, actual, '', paths);
			for (const path of paths) problems.push(`${section} ${doc._id}: ${path} đọc lại khác nguồn`);
		}
	}
	return problems.length > MAX_PROBLEMS
		? [...problems.slice(0, MAX_PROBLEMS), `… và ${problems.length - MAX_PROBLEMS} chỗ khác`]
		: problems;
}

module.exports = { compareStore };
