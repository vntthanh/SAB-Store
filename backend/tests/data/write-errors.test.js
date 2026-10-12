/**
 * Repositories report a refused write as a domain error, so callers (and the
 * Postgres implementation) never inspect an engine's error name or code.
 */
const { products, combos } = require('../../data');
const { DuplicateKeyError, RecordValidationError, InvalidIdError } = require('../../data/errors');
const { translateWriteError } = require('../../data/mongo/errors');
const Product = require('../../models/Product');
const { makeProduct, makeCombo } = require('../helpers/factories');
const { POSTGRES } = require('../helpers/backend');

const VALID = { name: 'Bút', price: 1000, category: 'general' };

describe('repository write errors', () => {
	it('product create reports a schema rule as RecordValidationError with the messages in field order', async () => {
		const error = await products.create({ ...VALID, price: -5, name: '' }, 0, null).catch((e) => e);

		expect(error).toBeInstanceOf(RecordValidationError);
		const fields = error.fieldErrors.map((entry) => entry.field);
		expect(fields).toContain('name');
		expect(fields).toContain('price');
		for (const entry of error.fieldErrors) expect(typeof entry.message).toBe('string');
	});

	it('product create reports a taken unique value as DuplicateKeyError naming the field', async () => {
		const first = await makeProduct();
		const error = await products.create({ ...VALID, publicCode: first.publicCode }, 0, null).catch((e) => e);

		expect(error).toBeInstanceOf(DuplicateKeyError);
		expect(error.fields).toEqual(['publicCode']);
	});

	it('reports a value of the wrong type as InvalidIdError carrying the field and the value', async () => {
		const error = await products.findById('not-an-id').catch((e) => e);

		expect(error).toBeInstanceOf(InvalidIdError);
		expect(error.value).toBe('not-an-id');
		expect(error.path).toBe('_id');
	});

	it('combo update reports a value that cannot be stored as a number as a validation error on that field', async () => {
		const combo = await makeCombo();

		const error = await combos.update(combo._id.toString(), { price: 'abc' }).catch((e) => e);

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(error.fieldErrors.map((entry) => entry.field)).toEqual(['price']);
	});

	it('does not touch an error that is none of the three', async () => {
		const failure = new Error('boom');

		expect(translateWriteError(failure)).toBe(failure);
	});

	// Skipped on Postgres: spies on Product.findByIdAndUpdate to fake an engine error; the Postgres translation is covered by contract/postgres-write-errors.test.js.
	it.skipIf(POSTGRES)('product update reports a taken unique value as DuplicateKeyError', async () => {
		const product = await makeProduct();
		vi.spyOn(Product, 'findByIdAndUpdate').mockRejectedValueOnce(
			Object.assign(new Error('E11000'), { code: 11000, keyPattern: { sku: 1 } })
		);

		const error = await products.update(product._id.toString(), { name: 'Khác' }).catch((e) => e);

		expect(error).toBeInstanceOf(DuplicateKeyError);
		expect(error.fields).toEqual(['sku']);
	});

	it('names every field of a compound index when the error carries only its message', () => {
		const bulk = Object.assign(new Error('E11000 duplicate key error collection: x index: a_1_b_-1 dup key: { }'), { code: 11000 });

		expect(translateWriteError(bulk).fields).toEqual(['a', 'b']);
	});

	it('reports no field when the error does not name one', () => {
		expect(translateWriteError(Object.assign(new Error('E11000'), { code: 11000 })).fields).toEqual([]);
	});
});
