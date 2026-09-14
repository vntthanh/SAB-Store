/**
 * Unit-level coverage of services/stock.js — the guarded $inc primitives
 * every money/inventory route in this phase is built on.
 */
const {
	adjustStock,
	deductStock,
	restoreStock,
	deductStockForItems,
	restoreStockForItems,
	applyStatusTransitionStockEffect
} = require('../../services/stock');
const { makeProduct } = require('../helpers/factories');
const Product = require('../../models/Product');

describe('deductStock / restoreStock', () => {
	it('deducts stock atomically when enough is available', async () => {
		const product = await makeProduct({ stockQuantity: 10 });
		const updated = await deductStock(product._id, 3);
		expect(updated.stockQuantity).toBe(7);

		const fromDb = await Product.findById(product._id);
		expect(fromDb.stockQuantity).toBe(7);
	});

	it('rejects a deduction larger than available stock, leaving stock untouched', async () => {
		const product = await makeProduct({ stockQuantity: 2 });

		await expect(deductStock(product._id, 3)).rejects.toMatchObject({
			name: 'StockError',
			code: 'INSUFFICIENT_STOCK'
		});

		const fromDb = await Product.findById(product._id);
		expect(fromDb.stockQuantity).toBe(2);
	});

	it('never allows stock to go negative even at the exact boundary', async () => {
		const product = await makeProduct({ stockQuantity: 1 });
		await deductStock(product._id, 1);

		const fromDb = await Product.findById(product._id);
		expect(fromDb.stockQuantity).toBe(0);

		await expect(deductStock(product._id, 1)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
	});

	it('restoreStock increments unconditionally', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const updated = await restoreStock(product._id, 5);
		expect(updated.stockQuantity).toBe(5);
	});

	it('rejects non-positive or non-integer quantities', async () => {
		const product = await makeProduct({ stockQuantity: 10 });
		await expect(deductStock(product._id, 0)).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
		await expect(deductStock(product._id, -1)).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
		await expect(deductStock(product._id, 1.5)).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
	});
});

describe('adjustStock (arbitrary delta)', () => {
	it('applies a positive delta', async () => {
		const product = await makeProduct({ stockQuantity: 10 });
		const updated = await adjustStock(product._id, 15);
		expect(updated.stockQuantity).toBe(25);
	});

	it('applies a negative delta guarded against going below zero', async () => {
		const product = await makeProduct({ stockQuantity: 10 });
		const updated = await adjustStock(product._id, -10);
		expect(updated.stockQuantity).toBe(0);

		await expect(adjustStock(product._id, -1)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
	});

	it('rejects a zero delta', async () => {
		const product = await makeProduct({ stockQuantity: 10 });
		await expect(adjustStock(product._id, 0)).rejects.toMatchObject({ code: 'INVALID_DELTA' });
	});

	it('reports PRODUCT_NOT_FOUND for a positive delta on a missing product', async () => {
		const { Types } = require('mongoose');
		await expect(adjustStock(new Types.ObjectId(), 5)).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
	});
});

describe('deductStockForItems — compensation on partial failure', () => {
	it('deducts every line when all have enough stock', async () => {
		const a = await makeProduct({ stockQuantity: 10 });
		const b = await makeProduct({ stockQuantity: 10 });

		await deductStockForItems([
			{ productId: a._id, quantity: 4 },
			{ productId: b._id, quantity: 6 }
		]);

		expect((await Product.findById(a._id)).stockQuantity).toBe(6);
		expect((await Product.findById(b._id)).stockQuantity).toBe(4);
	});

	it('rolls back every already-deducted line when a later line is short — no stock stays deducted', async () => {
		const a = await makeProduct({ stockQuantity: 10 });
		const b = await makeProduct({ stockQuantity: 10 });
		const short = await makeProduct({ stockQuantity: 1 }); // will fail

		await expect(
			deductStockForItems([
				{ productId: a._id, quantity: 4 },
				{ productId: b._id, quantity: 6 },
				{ productId: short._id, quantity: 5 }
			])
		).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

		// a and b were deducted, then compensated back to their original values.
		expect((await Product.findById(a._id)).stockQuantity).toBe(10);
		expect((await Product.findById(b._id)).stockQuantity).toBe(10);
		expect((await Product.findById(short._id)).stockQuantity).toBe(1);
	});
});

describe('restoreStockForItems', () => {
	it('restores every line', async () => {
		const a = await makeProduct({ stockQuantity: 0 });
		const b = await makeProduct({ stockQuantity: 0 });

		await restoreStockForItems([
			{ productId: a._id, quantity: 3 },
			{ productId: b._id, quantity: 7 }
		]);

		expect((await Product.findById(a._id)).stockQuantity).toBe(3);
		expect((await Product.findById(b._id)).stockQuantity).toBe(7);
	});
});

describe('applyStatusTransitionStockEffect', () => {
	const items = () => [{ productId: 'irrelevant-for-these-assertions-on-null-return', quantity: 1 }];

	it('returns null (no stock action) for a transition that is neither a cancel nor an un-cancel', async () => {
		const result = await applyStatusTransitionStockEffect({
			items: items(),
			isDirectSale: true,
			stockDeducted: true,
			previousStatus: 'confirmed',
			newStatus: 'paid'
		});
		expect(result).toBeNull();
	});

	it('returns null for cancelling an order that never deducted stock (web order)', async () => {
		const result = await applyStatusTransitionStockEffect({
			items: items(),
			isDirectSale: false,
			stockDeducted: false,
			previousStatus: 'confirmed',
			newStatus: 'cancelled'
		});
		expect(result).toBeNull();
	});

	it('restores stock and returns false when cancelling an order that had stock deducted', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const result = await applyStatusTransitionStockEffect({
			items: [{ productId: product._id, quantity: 4 }],
			isDirectSale: true,
			stockDeducted: true,
			previousStatus: 'paid',
			newStatus: 'cancelled'
		});
		expect(result).toBe(false);
		expect((await Product.findById(product._id)).stockQuantity).toBe(4);
	});

	it('returns null for un-cancelling a web order — never deducts stock even coming out of cancelled', async () => {
		const result = await applyStatusTransitionStockEffect({
			items: items(),
			isDirectSale: false,
			stockDeducted: false,
			previousStatus: 'cancelled',
			newStatus: 'confirmed'
		});
		expect(result).toBeNull();
	});

	it('re-deducts stock and returns true when un-cancelling a direct sale that had been restored', async () => {
		const product = await makeProduct({ stockQuantity: 4 });
		const result = await applyStatusTransitionStockEffect({
			items: [{ productId: product._id, quantity: 4 }],
			isDirectSale: true,
			stockDeducted: false,
			previousStatus: 'cancelled',
			newStatus: 'confirmed'
		});
		expect(result).toBe(true);
		expect((await Product.findById(product._id)).stockQuantity).toBe(0);
	});

	it('rejects un-cancelling a direct sale when stock is no longer sufficient', async () => {
		const product = await makeProduct({ stockQuantity: 1 });
		await expect(applyStatusTransitionStockEffect({
			items: [{ productId: product._id, quantity: 4 }],
			isDirectSale: true,
			stockDeducted: false,
			previousStatus: 'cancelled',
			newStatus: 'confirmed'
		})).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

		// Nothing partially applied.
		expect((await Product.findById(product._id)).stockQuantity).toBe(1);
	});
});
