/**
 * Product.findSellable / Combo.findSellable — the single "sellable on channel K"
 * rule. `available` is the master switch; `salesChannel` narrows it to a channel.
 * `Product.isActive` is deprecated and must never influence the result.
 */
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const { makeProduct, makeCombo } = require('../helpers/factories');

const idsOf = (docs) => docs.map((d) => d._id.toString());

describe('Product.findSellable', () => {
	it('exposes SALES_CHANNELS and defaults salesChannel to "all"', async () => {
		expect(Product.SALES_CHANNELS).toEqual(['all', 'online', 'offline']);
		const product = await makeProduct();
		expect(product.salesChannel).toBe('all');
	});

	it('throws when the channel is missing or unknown instead of defaulting to one', () => {
		expect(() => Product.findSellable()).toThrow();
		expect(() => Product.findSellable('pos')).toThrow();
		// "all" describes what a product allows, not a channel a sale happens on.
		expect(() => Product.findSellable('all')).toThrow();
		expect(() => Product.sellableQuery(undefined)).toThrow();
	});

	it('filters by channel: online-only and offline-only products stay on their own channel', async () => {
		const both = await makeProduct({ salesChannel: 'all' });
		const online = await makeProduct({ salesChannel: 'online' });
		const offline = await makeProduct({ salesChannel: 'offline' });

		const onlineIds = idsOf(await Product.findSellable('online'));
		expect(onlineIds).toEqual(expect.arrayContaining([both._id.toString(), online._id.toString()]));
		expect(onlineIds).not.toContain(offline._id.toString());

		const offlineIds = idsOf(await Product.findSellable('offline'));
		expect(offlineIds).toEqual(expect.arrayContaining([both._id.toString(), offline._id.toString()]));
		expect(offlineIds).not.toContain(online._id.toString());
	});

	it('treats a document written before the field existed as "all" on both channels', async () => {
		// Mongoose applies schema defaults when hydrating, not when querying, so a
		// raw legacy document has no salesChannel at all. The query must still match.
		const { insertedId } = await Product.collection.insertOne({
			name: 'Legacy product',
			price: 1000,
			category: 'general',
			available: true,
			stockQuantity: 3
		});

		expect(idsOf(await Product.findSellable('online'))).toContain(insertedId.toString());
		expect(idsOf(await Product.findSellable('offline'))).toContain(insertedId.toString());
	});

	it('never lists available:false, whatever the channel', async () => {
		const stopped = await makeProduct({ available: false, salesChannel: 'all' });

		expect(idsOf(await Product.findSellable('online'))).not.toContain(stopped._id.toString());
		expect(idsOf(await Product.findSellable('offline'))).not.toContain(stopped._id.toString());
	});

	it('ignores the deprecated isActive flag', async () => {
		// isActive had no UI and no owner; one master switch (`available`) replaced it.
		const product = await makeProduct({ isActive: false, available: true });

		expect(idsOf(await Product.findSellable('online'))).toContain(product._id.toString());
		expect(idsOf(await Product.findSellable('offline'))).toContain(product._id.toString());
	});

	it('combines with a caller filter that has its own $or without clobbering either', async () => {
		const wanted = await makeProduct({ name: 'needle in stock', salesChannel: 'online' });
		await makeProduct({ name: 'needle wrong channel', salesChannel: 'offline' });
		await makeProduct({ name: 'unrelated', salesChannel: 'online' });

		const found = await Product.findSellable('online', {
			$or: [{ name: /needle/ }, { description: /needle/ }]
		});

		expect(idsOf(found)).toEqual([wanted._id.toString()]);
	});

	it('findFeatured requires a channel and only returns sellable featured products', async () => {
		const featured = await makeProduct({ featured: true, salesChannel: 'online' });
		await makeProduct({ featured: true, salesChannel: 'offline' });
		await makeProduct({ featured: false, salesChannel: 'online' });

		expect(() => Product.findFeatured()).toThrow();
		expect(idsOf(await Product.findFeatured('online'))).toEqual([featured._id.toString()]);
	});
});

describe('Combo.findSellable', () => {
	it('defaults salesChannel to "all" and throws without a valid channel', async () => {
		const combo = await makeCombo();
		expect(combo.salesChannel).toBe('all');
		expect(() => Combo.findSellable()).toThrow();
		expect(() => Combo.findSellable('pos')).toThrow();
	});

	it('filters by channel and by isActive', async () => {
		const both = await makeCombo({ salesChannel: 'all' });
		const online = await makeCombo({ salesChannel: 'online' });
		const offline = await makeCombo({ salesChannel: 'offline' });
		const off = await makeCombo({ salesChannel: 'all', isActive: false });

		const onlineIds = idsOf(await Combo.findSellable('online'));
		expect(onlineIds).toEqual(expect.arrayContaining([both._id.toString(), online._id.toString()]));
		expect(onlineIds).not.toContain(offline._id.toString());
		expect(onlineIds).not.toContain(off._id.toString());

		const offlineIds = idsOf(await Combo.findSellable('offline'));
		expect(offlineIds).toEqual(expect.arrayContaining([both._id.toString(), offline._id.toString()]));
		expect(offlineIds).not.toContain(online._id.toString());
	});

	it('treats a legacy combo without the field as "all" on both channels', async () => {
		const { insertedId } = await Combo.collection.insertOne({
			name: 'Legacy combo',
			price: 1000,
			categoryRequirements: [{ category: 'general', quantity: 1 }],
			isActive: true,
			priority: 0
		});

		expect(idsOf(await Combo.findSellable('online'))).toContain(insertedId.toString());
		expect(idsOf(await Combo.findSellable('offline'))).toContain(insertedId.toString());
	});

	it('orders by priority, then newest', async () => {
		const low = await makeCombo({ priority: 1 });
		const high = await makeCombo({ priority: 5 });

		expect(idsOf(await Combo.findSellable('online'))).toEqual([high._id.toString(), low._id.toString()]);
	});
});
