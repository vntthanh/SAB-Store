/**
 * computeOrderPricing(items, { channel }) — the channel is mandatory, and a
 * line that cannot be sold on that channel rejects the whole cart.
 */
const mongoose = require('mongoose');
const { computeOrderPricing, PricingError } = require('../../services/pricing');
const { makeProduct, makeCombo } = require('../helpers/factories');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');

const line = (product, quantity = 1) => ({ productId: product._id.toString(), quantity });

describe('computeOrderPricing — channel is required', () => {
	it('throws when called without options or without a channel', async () => {
		const product = await makeProduct();

		await expect(computeOrderPricing([line(product)])).rejects.toThrow(/channel/);
		await expect(computeOrderPricing([line(product)], {})).rejects.toThrow(/channel/);
		await expect(computeOrderPricing([line(product)], { channel: 'pos' })).rejects.toThrow(/channel/);
		await expect(computeOrderPricing([line(product)], { channel: 'all' })).rejects.toThrow(/channel/);
	});

	it('is not a PricingError: a missing channel is a programming error, not a bad cart', async () => {
		const product = await makeProduct();

		const err = await computeOrderPricing([line(product)]).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(PricingError);
	});
});

describe('computeOrderPricing — product channel rules', () => {
	it('sells an online-only product on online, rejects it on offline naming the product', async () => {
		const product = await makeProduct({ name: 'Lanyard Online Only', salesChannel: 'online' });

		const result = await computeOrderPricing([line(product)], { channel: 'online' });
		expect(result.totalAmount).toBe(product.price);

		await expect(computeOrderPricing([line(product)], { channel: 'offline' })).rejects.toMatchObject({
			name: 'PricingError',
			code: 'PRODUCT_CHANNEL_MISMATCH',
			httpStatus: 400,
			details: {
				channel: 'offline',
				missingIds: [product._id.toString()],
				productNames: ['Lanyard Online Only']
			}
		});
	});

	it('sells an offline-only product on offline, rejects it on online', async () => {
		const product = await makeProduct({ name: 'Counter Only', salesChannel: 'offline' });

		await expect(computeOrderPricing([line(product)], { channel: 'offline' })).resolves.toMatchObject({
			totalAmount: product.price
		});
		await expect(computeOrderPricing([line(product)], { channel: 'online' })).rejects.toMatchObject({
			code: 'PRODUCT_CHANNEL_MISMATCH',
			details: { productNames: ['Counter Only'] }
		});
	});

	it('rejects available:false on both channels as PRODUCT_UNAVAILABLE, not as a channel problem', async () => {
		const product = await makeProduct({ available: false, salesChannel: 'all' });

		for (const channel of ['online', 'offline']) {
			await expect(computeOrderPricing([line(product)], { channel })).rejects.toMatchObject({
				code: 'PRODUCT_UNAVAILABLE'
			});
		}
	});

	it('reports PRODUCT_UNAVAILABLE when a cart mixes a stopped product with a wrong-channel one', async () => {
		const stopped = await makeProduct({ available: false });
		const wrongChannel = await makeProduct({ salesChannel: 'offline' });

		await expect(
			computeOrderPricing([line(stopped), line(wrongChannel)], { channel: 'online' })
		).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
	});

	it('does not leak a product that does not exist as a channel mismatch', async () => {
		const missingId = new mongoose.Types.ObjectId().toString();

		await expect(
			computeOrderPricing([{ productId: missingId, quantity: 1 }], { channel: 'online' })
		).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE', details: { missingIds: [missingId] } });
	});

	it('sells isActive:false when available:true (isActive is deprecated and unread)', async () => {
		const product = await makeProduct({ isActive: false, available: true });

		await expect(computeOrderPricing([line(product)], { channel: 'online' })).resolves.toMatchObject({
			totalAmount: product.price
		});
		await expect(computeOrderPricing([line(product)], { channel: 'offline' })).resolves.toMatchObject({
			totalAmount: product.price
		});
	});

	it('treats a legacy product without salesChannel as sellable on both channels', async () => {
		const { insertedId } = await Product.collection.insertOne({
			name: 'Legacy',
			price: 7000,
			category: 'general',
			available: true,
			stockQuantity: 5
		});

		for (const channel of ['online', 'offline']) {
			const result = await computeOrderPricing([{ productId: insertedId.toString(), quantity: 2 }], { channel });
			expect(result.totalAmount).toBe(14000);
		}
	});
});

describe('computeOrderPricing — combo channel rules', () => {
	async function comboCart(comboOverrides) {
		const a = await makeProduct({ category: 'lanyard', price: 100000 });
		const b = await makeProduct({ category: 'sticker', price: 50000 });
		const combo = await makeCombo({
			price: 120000,
			categoryRequirements: [
				{ category: 'lanyard', quantity: 1 },
				{ category: 'sticker', quantity: 1 }
			],
			...comboOverrides
		});
		return { combo, items: [line(a), line(b)] };
	}

	it('an offline-only combo gives no discount online but discounts at the counter', async () => {
		const { items } = await comboCart({ salesChannel: 'offline' });

		const online = await computeOrderPricing(items, { channel: 'online' });
		expect(online.comboInfo).toBeNull();
		expect(online.totalAmount).toBe(150000);

		const offline = await computeOrderPricing(items, { channel: 'offline' });
		expect(offline.comboInfo).not.toBeNull();
		expect(offline.totalAmount).toBe(120000);
	});

	it('an online-only combo discounts online but not at the counter', async () => {
		const { items } = await comboCart({ salesChannel: 'online' });

		expect((await computeOrderPricing(items, { channel: 'online' })).totalAmount).toBe(120000);
		const offline = await computeOrderPricing(items, { channel: 'offline' });
		expect(offline.comboInfo).toBeNull();
		expect(offline.totalAmount).toBe(150000);
	});

	it('a legacy combo document without the field applies on both channels', async () => {
		const a = await makeProduct({ category: 'lanyard', price: 100000 });
		const b = await makeProduct({ category: 'sticker', price: 50000 });
		await Combo.collection.insertOne({
			name: 'Legacy combo',
			price: 120000,
			categoryRequirements: [
				{ category: 'lanyard', quantity: 1 },
				{ category: 'sticker', quantity: 1 }
			],
			isActive: true,
			priority: 0
		});

		for (const channel of ['online', 'offline']) {
			const result = await computeOrderPricing([line(a), line(b)], { channel });
			expect(result.totalAmount).toBe(120000);
		}
	});
});
