/**
 * Record ids on each backend: the same input rules, and on postgres the legacy
 * 24-hex ids (carts, queued jobs, old backups) map to the uuid the row was
 * migrated under. Run with `pnpm test:contract:postgres` for the postgres half.
 */
const { objectIdToUuidV7 } = require('@sab/shared');
const { products } = require('../../data');
const { InvalidIdError } = require('../../data/errors');
const { isRecordId, normalizeRecordId } = require('../../data/ids');
const { recordAppliedOpening } = require('../../services/stock-ledger');
const { insertRawProduct, newId, findProduct, movements } = require('../helpers/db');

const POSTGRES = process.env.DATA_BACKEND === 'postgres';
const LEGACY_HEX = '6acc24c7924609c6bfb78bef';
const mapped = (hex) => (POSTGRES ? objectIdToUuidV7(hex) : hex);

afterAll(async () => {
	if (POSTGRES) await require('../../lib/prisma').closeDb();
});

describe('record ids', () => {
	it('normalises an uppercase hex id, mapping it to its uuid on postgres', () => {
		expect(normalizeRecordId(LEGACY_HEX.toUpperCase())).toBe(mapped(LEGACY_HEX));
		expect(normalizeRecordId(LEGACY_HEX)).toBe(mapped(LEGACY_HEX));
	});

	it('normalises a fresh id to lowercase', () => {
		const id = newId();

		expect(normalizeRecordId(id.toUpperCase())).toBe(id);
		expect(isRecordId(id)).toBe(true);
	});

	it.each([['not hex', 'zzzzzzzzzzzzzzzzzzzzzzzz'], ['too short', '6acc24c7'], ['empty', ''], ['a number', 12], ['null', null], ['undefined', undefined], ['an object', {}], ['an array', ['6acc24c7924609c6bfb78bef']]])(
		'refuses %s',
		(_label, value) => {
			expect(isRecordId(value)).toBe(false);
			expect(() => normalizeRecordId(value)).toThrow(InvalidIdError);
		}
	);

	it('accepts the other backend\'s id form only on postgres', () => {
		expect(isRecordId(objectIdToUuidV7(LEGACY_HEX))).toBe(POSTGRES);
		expect(isRecordId(LEGACY_HEX)).toBe(true);
	});

	it('maps a legacy hex id to the same row a lookup by its new id finds', async () => {
		const created = await products.create({ _id: LEGACY_HEX, name: 'Imported', price: 1, category: 'c' }, 0, null);

		expect(created._id).toBe(mapped(LEGACY_HEX));
		expect((await findProduct(mapped(LEGACY_HEX))).name).toBe('Imported');
		expect((await products.findById(LEGACY_HEX))._id).toBe(created._id);
		expect(await products.exists(LEGACY_HEX.toUpperCase())).toBe(true);
		expect((await products.update(LEGACY_HEX, { price: 2 })).price).toBe(2);
		expect(await products.remove(LEGACY_HEX)).toBe(true);
	});

	it('records one opening movement whether the caller holds the legacy hex id or the mapped one', async () => {
		await products.create({ _id: LEGACY_HEX, name: 'Opened twice', price: 1, category: 'c' }, 0, null);

		const first = await recordAppliedOpening({ productId: LEGACY_HEX, quantity: 4 });
		const second = await recordAppliedOpening({ productId: mapped(LEGACY_HEX), quantity: 4 });
		const third = await recordAppliedOpening({ productId: LEGACY_HEX.toUpperCase(), quantity: 4 });

		expect(String(second._id)).toBe(String(first._id));
		expect(String(third._id)).toBe(String(first._id));
		expect(first.idempotencyKey).toBe(`opening:${mapped(LEGACY_HEX)}`);
		expect(await movements({ productId: mapped(LEGACY_HEX) })).toHaveLength(1);
	});

	it('prices and names products given legacy hex ids without reaching the store with a malformed id', async () => {
		await products.create({ _id: LEGACY_HEX, name: 'Hex priced', price: 7, category: 'c' }, 0, null);

		const priced = await products.findSellableForPricing('online', [LEGACY_HEX], ['name', 'salePrice']);

		expect(priced.map((record) => record.name)).toEqual(['Hex priced']);
		expect(await products.findAvailableNames([LEGACY_HEX])).toEqual(['Hex priced']);
	});

	it('finds a row that was migrated under the mapped id', async () => {
		const row = await insertRawProduct({ name: 'Migrated' });

		expect((await products.findById(row._id.toUpperCase()))._id).toBe(row._id);
	});

	it.skipIf(!POSTGRES)('does not mistake a legacy hex id for a row stored under another id', async () => {
		await insertRawProduct({ name: 'Other' });

		expect(await products.findById(LEGACY_HEX)).toBeNull();
	});
});
