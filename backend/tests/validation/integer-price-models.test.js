/**
 * Prices are whole VND. The Mongoose Product and Combo schemas reject a
 * fractional price themselves, so a write that skips the routes cannot store
 * one on the rollback store. This covers only those model validators:
 * `validate()` runs them without a connection, on either backend. The same rule
 * on Postgres is covered through the repositories in contract/catalog.contract.test.js.
 */
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');

const MESSAGE = 'Giá phải là số nguyên (VND)';

describe('integer prices on the models', () => {
	it('rejects a fractional product price and accepts an integer one', async () => {
		await expect(new Product({ name: 'P', price: 10.5, category: 'g' }).validate()).rejects.toThrow(MESSAGE);
		await expect(new Product({ name: 'P', price: 10, category: 'g' }).validate()).resolves.toBeUndefined();
	});

	it('rejects a fractional combo price', async () => {
		await expect(
			new Combo({ name: 'C', price: 99.99, categoryRequirements: [{ category: 'g', quantity: 1 }] }).validate()
		).rejects.toThrow(MESSAGE);
	});
});
