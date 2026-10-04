const Product = require('../../models/Product');
const StockMovement = require('../../models/StockMovement');
const { recordMovement, applyMovement, reconcile } = require('../../services/stock-ledger');
const { backfillOpening } = require('../../scripts/backfill-stock-opening');
const { makeProduct } = require('../helpers/factories');

beforeAll(async () => {
	await StockMovement.init();
});

describe('backfill-stock-opening', () => {
	it('dry run writes nothing; apply records one applied opening per product; a re-run records none', async () => {
		const [a, b, zero] = await Promise.all([
			makeProduct({ stockQuantity: 12 }),
			makeProduct({ stockQuantity: 0 }),
			makeProduct({ stockQuantity: 0 })
		]);
		// Negative stock is legitimate (orders are never refused) but the schema's
		// min:0 only guards save(); write it the way the ledger does.
		await Product.updateOne({ _id: b._id }, { $set: { stockQuantity: -3 } });
		expect(await reconcile()).toHaveLength(2);

		const dry = await backfillOpening({ apply: false });
		expect(dry).toEqual({ products: 3, alreadyBaselined: 0, toCreate: 3, created: 0 });
		expect(await StockMovement.countDocuments({})).toBe(0);

		const applied = await backfillOpening({ apply: true });
		expect(applied).toEqual({ products: 3, alreadyBaselined: 0, toCreate: 3, created: 3 });
		const openings = await StockMovement.find({}).lean();
		expect(openings).toHaveLength(3);
		expect(openings.every((m) => m.type === 'opening' && m.status === 'applied')).toBe(true);
		expect(openings.find((m) => String(m.productId) === String(a._id))).toMatchObject({ delta: 12, stockAfter: 12 });
		expect(openings.find((m) => String(m.productId) === String(b._id))).toMatchObject({ delta: -3, stockAfter: -3 });
		expect(await reconcile()).toEqual([]);
		expect((await Product.findById(zero._id)).stockQuantity).toBe(0);

		const again = await backfillOpening({ apply: true });
		expect(again).toEqual({ products: 3, alreadyBaselined: 3, toCreate: 0, created: 0 });
		expect(await StockMovement.countDocuments({})).toBe(3);
	});

	it('lands on the cache instead of double-counting movements applied before it ran', async () => {
		const product = await makeProduct({ stockQuantity: 10 });
		const m = await recordMovement({ productId: product._id, type: 'order', delta: -3, idempotencyKey: 'pre-backfill' });
		await applyMovement(m._id);

		await backfillOpening({ apply: true });

		expect((await Product.findById(product._id)).stockQuantity).toBe(7);
		expect(await StockMovement.findOne({ type: 'opening' }).lean()).toMatchObject({ delta: 10, stockAfter: 7 });
		expect(await reconcile()).toEqual([]);
	});
});
