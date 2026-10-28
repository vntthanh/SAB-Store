/**
 * Repositories report a refused write as a domain error, so callers never
 * inspect an engine's error name or code.
 */
const { products, combos } = require('../../data');
const { DuplicateKeyError, RecordValidationError, InvalidIdError } = require('../../data/errors');
const { makeProduct, makeCombo } = require('../helpers/factories');

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
});
