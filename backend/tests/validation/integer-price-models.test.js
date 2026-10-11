/**
 * Prices are whole VND. The Product and Combo schemas reject a fractional
 * price themselves, so a write that skips the routes cannot store one. This
 * tests the model validators and stays on the models.
 */
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');

const MESSAGE = 'Giá phải là số nguyên (VND)';

describe('integer prices on the models', () => {
	it('rejects a fractional product price and accepts an integer one', async () => {
		await expect(Product.create({ name: 'P', price: 10.5, category: 'g' })).rejects.toThrow(MESSAGE);
		await expect(Product.create({ name: 'P', price: 10, category: 'g' })).resolves.toBeTruthy();
	});

	it('rejects a fractional combo price', async () => {
		await expect(
			Combo.create({ name: 'C', price: 99.99, categoryRequirements: [{ category: 'g', quantity: 1 }] })
		).rejects.toThrow(MESSAGE);
	});
});
