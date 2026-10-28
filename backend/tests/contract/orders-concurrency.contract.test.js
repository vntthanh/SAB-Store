/**
 * What racing writers of one order may and may not do, on whichever backend
 * DATA_BACKEND selects: status transitions with their stock effect, the item-edit
 * compare-and-set, notes, and the order/cancel/apply loops that must leave the
 * stock cache exactly equal to the units still held by live orders.
 */
const data = require('../../data');
const { transitionOrderWithStock, recordOrderMovements } = require('../../services/stock');
const { editOrderItems } = require('../../services/order-edit');
const { applyMovement, reconcile } = require('../../services/stock-ledger');
const { RecordValidationError } = require('../../data/errors');
const {
	newId, insertRawProduct, findOrder, movements, stockOf, countRows, withTransaction,
	stockKeyIdOf,
} = require('../helpers/db');

const { orders } = data;
const POSTGRES = process.env.DATA_BACKEND === 'postgres';

afterAll(async () => {
	if (POSTGRES) await require('../../lib/prisma').closeDb();
});

let sequence = 0;
const nextCode = () => `R${Date.now().toString(36).slice(-4).toUpperCase()}${++sequence}`.slice(0, 10);

const makeProduct = (fields = {}) => insertRawProduct({ name: `Race Product ${++sequence}`, price: 1000, category: 'general', available: true, stockQuantity: 0, ...fields });
const lineOf = (product, quantity = 1) => ({ productId: product._id, productName: product.name, price: product.price, quantity });

/** An order that holds stock, with its pending `order` movements recorded in the same transaction, as checkout does. */
function placeOrder(items, extra = {}) {
	return data.withTransaction(async (tx) => {
		const order = await orders.create({
			orderCode: nextCode(),
			studentId: 'SV001',
			fullName: 'Racer',
			email: 'racer@test.vn',
			phoneNumber: '0912345678',
			items,
			totalAmount: items.reduce((sum, line) => sum + line.price * line.quantity, 0),
			status: 'confirmed',
			stockDeducted: true,
			comboInfo: null,
			statusHistory: [{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date() }],
			...extra
		}, tx);
		await recordOrderMovements({ orderId: order._id, items, type: 'order', keyTag: 'create', createdBy: 'system', reason: 'test' }, { tx });
		return order;
	});
}

/** The change the status routes build. */
const transition = (orderId, status, actor = 'admin') => transitionOrderWithStock({
	orderId,
	status,
	actor,
	setFields: { status, statusUpdatedAt: new Date(), lastUpdatedBy: actor },
	historyEntry: { status, updatedAt: new Date(), updatedBy: actor }
});

const outcomes = (results) => results.map((result) => result.outcome).sort();

/** Run `work` over `items` with at most `size` in flight. */
async function inWaves(items, size, work) {
	const results = [];
	for (let from = 0; from < items.length; from += size) {
		results.push(...await Promise.all(items.slice(from, from + size).map(work)));
	}
	return results;
}

/** Apply a movement until it is done, retrying while an older one for the same product is still pending. */
async function applyUntilDone(movementId) {
	for (let round = 0; round < 400; round += 1) {
		const result = await applyMovement(movementId);
		if (!result.deferred) return result;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('movement stayed deferred');
}

async function applyAllPending() {
	for (let round = 0; round < 50; round += 1) {
		const pending = await movements({ status: 'pending' });
		if (pending.length === 0) return;
		await Promise.all(pending.map((movement) => applyUntilDone(movement._id)));
	}
	throw new Error('movements stayed pending');
}

describe('status transitions with their stock effect', () => {
	it('cancelling an order that holds stock records one order_cancel and gives the units back once applied', async () => {
		const product = await makeProduct();
		const order = await placeOrder([lineOf(product, 3)]);
		await applyAllPending();
		expect(await stockOf(product._id)).toBe(-3);

		const result = await transition(order._id, 'cancelled');

		expect(result.outcome).toBe('ok');
		expect(result.order).toMatchObject({ status: 'cancelled', stockDeducted: false });
		expect(result.order.statusHistory).toHaveLength(2);
		const cancels = await movements({ type: 'order_cancel' });
		expect(cancels).toHaveLength(1);
		expect(cancels[0]).toMatchObject({ delta: 3, idempotencyKey: `order:${order._id}:${product._id}:cancel:2` });
		await applyAllPending();
		expect(await stockOf(product._id)).toBe(0);
	});

	it('returns the units only once when the order is cancelled twice, in turn or at the same time', async () => {
		const product = await makeProduct();
		const order = await placeOrder([lineOf(product, 2)]);

		const first = await transition(order._id, 'cancelled');
		const again = await transition(order._id, 'cancelled');
		expect([first.outcome, again.outcome]).toEqual(['ok', 'final']);

		const second = await placeOrder([lineOf(product, 2)]);
		const results = await Promise.all([transition(second._id, 'cancelled'), transition(second._id, 'cancelled')]);
		expect(outcomes(results)).toEqual(['final', 'ok']);

		await applyAllPending();
		expect(await movements({ type: 'order_cancel' })).toHaveLength(2);
		expect(await stockOf(product._id)).toBe(0);
	});

	it('records nothing when the cancelled order never took stock', async () => {
		const product = await makeProduct();
		const order = await placeOrder([lineOf(product, 2)], { stockDeducted: false });
		const before = await countRows('movement');

		const result = await transition(order._id, 'cancelled');

		expect(result.outcome).toBe('ok');
		expect(result.movements).toEqual([]);
		expect(await countRows('movement')).toBe(before);
		expect(await findOrder(order._id)).toMatchObject({ status: 'cancelled', stockDeducted: false });
	});

	it('answers not_found, unchanged and final without writing', async () => {
		const product = await makeProduct();
		const order = await placeOrder([lineOf(product)]);

		expect((await transition(newId(), 'paid')).outcome).toBe('not_found');
		expect((await transition(order._id, 'confirmed')).outcome).toBe('unchanged');
		await transition(order._id, 'delivered');
		expect((await transition(order._id, 'paid')).outcome).toBe('final');
		expect((await findOrder(order._id)).statusHistory).toHaveLength(2);
	});

	it('lets exactly one of a cancel and a delivery racing each other win, the loser being told final', async () => {
		for (let round = 0; round < 30; round += 1) {
			const product = await makeProduct();
			const order = await placeOrder([lineOf(product, 1)]);

			const [cancel, delivery] = await Promise.all([transition(order._id, 'cancelled'), transition(order._id, 'delivered')]);

			expect(outcomes([cancel, delivery]), `round ${round}`).toEqual(['final', 'ok']);
			const stored = await findOrder(order._id);
			expect(stored.statusHistory, `round ${round}`).toHaveLength(2);
			const cancels = await movements({ type: 'order_cancel', productId: product._id });
			// The winner's answer and the stored status must agree.
			expect(cancel.outcome === 'ok', `round ${round}`).toBe(stored.status === 'cancelled');
			expect(delivery.outcome === 'ok', `round ${round}`).toBe(stored.status === 'delivered');
			if (stored.status === 'cancelled') {
				expect(cancels, `round ${round}`).toHaveLength(1);
				expect(stored.stockDeducted).toBe(false);
			} else {
				expect(cancels, `round ${round}`).toHaveLength(0);
				expect(stored.stockDeducted).toBe(true);
			}
		}
	});
});

describe('the compare-and-set of the repository', () => {
	const change = (orderId, status, fromStatus = 'confirmed') => ({
		orderId, fromStatus, fields: { status, lastUpdatedBy: status }, historyEntry: { status, updatedBy: status, updatedAt: new Date() }
	});

	it('applies one of two status changes made from the same status at the same time', async () => {
		for (let round = 0; round < 10; round += 1) {
			const order = await placeOrder([lineOf(await makeProduct())]);

			const results = await Promise.all(['paid', 'cancelled'].map((status) => data.withTransaction((tx) => orders.applyStatusChange(change(order._id, status), tx))));

			expect(results.filter(Boolean), `round ${round}`).toHaveLength(1);
			const stored = await findOrder(order._id);
			expect(stored.statusHistory.map((entry) => entry.status), `round ${round}`).toEqual(['confirmed', results.find(Boolean).status]);
			expect(stored.status).toBe(results.find(Boolean).status);
		}
	});

	it('refuses a change from a status the order no longer has, writing no history', async () => {
		const order = await placeOrder([lineOf(await makeProduct())]);

		expect(await data.withTransaction((tx) => orders.applyStatusChange(change(order._id, 'delivered', 'paid'), tx))).toBeNull();
		expect(await data.withTransaction((tx) => orders.applyStatusChange(change(order._id, 'delivered', 'pending'), tx))).toBeNull();
		expect(await data.withTransaction((tx) => orders.applyStatusChange(change(newId(), 'paid'), tx))).toBeNull();
		expect((await findOrder(order._id)).statusHistory).toHaveLength(1);
	});

	// The Mongo repository writes whatever fields it is handed; the allowlist is the postgres hardening.
	it.skipIf(!POSTGRES)('takes only the fields a transition sets', async () => {
		const order = await placeOrder([lineOf(await makeProduct())]);

		await expect(data.withTransaction((tx) => orders.applyStatusChange({ ...change(order._id, 'paid'), fields: { status: 'paid', totalAmount: 1 } }, tx))).rejects.toThrow('Cannot set order field');
		expect(await findOrder(order._id)).toMatchObject({ status: 'confirmed', totalAmount: 1000 });
	});

	it('refuses an invalid history entry and leaves the order untouched on a rollback', async () => {
		const order = await placeOrder([lineOf(await makeProduct())]);

		await expect(data.withTransaction((tx) => orders.applyStatusChange({ ...change(order._id, 'paid'), historyEntry: { status: 'paid' } }, tx))).rejects.toBeInstanceOf(RecordValidationError);
		await expect(data.withTransaction(async (tx) => {
			await orders.applyStatusChange(change(order._id, 'paid'), tx);
			throw new Error('rolled back');
		})).rejects.toThrow('rolled back');

		expect(await findOrder(order._id)).toMatchObject({ status: 'confirmed', lastUpdatedBy: 'system' });
		expect((await findOrder(order._id)).statusHistory).toHaveLength(1);
	});

	it('replaces the items of one of two edits made from the same revision at the same time', async () => {
		const [a, b] = [await makeProduct(), await makeProduct()];
		for (let round = 0; round < 10; round += 1) {
			const order = await placeOrder([lineOf(a, 2)]);
			const edit = (item) => data.withTransaction((tx) => orders.replaceItems({
				orderId: order._id, fromStatus: 'confirmed', fromRevision: 0, items: [item], comboInfo: null,
				historyEntry: { previousItems: order.items, previousComboInfo: null, editedBy: 'admin', editedAt: new Date(), reason: 'swap' }
			}, tx));

			const results = await Promise.all([edit(lineOf(a, 1)), edit(lineOf(b, 2))]);

			expect(results.filter(Boolean), `round ${round}`).toHaveLength(1);
			const stored = await findOrder(order._id);
			expect(stored.itemsRevision, `round ${round}`).toBe(1);
			expect(stored.itemsHistory, `round ${round}`).toHaveLength(1);
			expect(stored.items).toHaveLength(1);
			expect(stored.items[0].quantity).toBe(results.find(Boolean).items[0].quantity);
		}
	});

	it('refuses an item edit from a status or revision the order has moved past', async () => {
		const a = await makeProduct();
		const order = await placeOrder([lineOf(a, 2)]);
		const edit = (overrides) => data.withTransaction((tx) => orders.replaceItems({
			orderId: order._id, fromStatus: 'confirmed', fromRevision: 0, items: [lineOf(a, 1)], comboInfo: null,
			historyEntry: { previousItems: [], editedBy: 'admin', editedAt: new Date(), reason: 'r' }, ...overrides
		}, tx));

		expect(await edit({ fromRevision: 4 })).toBeNull();
		expect(await edit({ fromStatus: 'paid' })).toBeNull();
		expect(await edit({ historyEntry: { editedBy: 'admin' } }).catch((error) => error)).toBeInstanceOf(RecordValidationError);
		expect((await edit({})).itemsRevision).toBe(1);
		expect(await edit({})).toBeNull();
	});
});

describe('item edits through the service', () => {
	const setup = async () => {
		const [a, b] = [await makeProduct(), await makeProduct()];
		const order = await placeOrder([lineOf(a, 2)]);
		await applyAllPending();
		return { a, b, order };
	};
	const edit = (order, items, extra = {}) => editOrderItems({ orderId: order._id, items, expectedRevision: 0, reason: 'đổi màu', actor: 'admin', ...extra });
	const units = (record) => Object.fromEntries(record.items.map((line) => [String(line.productId), line.quantity]));

	it('keeps the total, records a movement per unit difference and appends the history', async () => {
		const { a, b, order } = await setup();

		const result = await edit(order, [{ productId: a._id, quantity: 1 }, { productId: b._id, quantity: 1 }]);

		expect(result.outcome).toBe('ok');
		expect(result.order).toMatchObject({ totalAmount: 2000, itemsRevision: 1 });
		expect(units(result.order)).toEqual({ [a._id]: 1, [b._id]: 1 });
		const stored = await findOrder(order._id);
		expect(stored.totalAmount).toBe(2000);
		expect(stored.itemsHistory).toHaveLength(1);
		expect(stored.itemsHistory[0]).toMatchObject({ editedBy: 'admin', reason: 'đổi màu' });
		expect(stored.itemsHistory[0].previousItems.map((line) => [String(line.productId), line.quantity])).toEqual([[a._id, 2]]);
		const editMovements = await movements({ type: 'order_edit' });
		expect(editMovements.map((movement) => [String(movement.productId), movement.delta]).sort()).toEqual([[a._id, 1], [b._id, -1]].sort());
		expect(editMovements.map((movement) => movement.idempotencyKey).sort())
			.toEqual([`order:${order._id}:${await stockKeyIdOf(a._id)}:edit:1`, `order:${order._id}:${await stockKeyIdOf(b._id)}:edit:1`].sort());
		await applyAllPending();
		expect([await stockOf(a._id), await stockOf(b._id)]).toEqual([-1, -1]);
	});

	it('answers total_changed, changed, unchanged and final without writing', async () => {
		const { a, b, order } = await setup();

		expect(await edit(order, [{ productId: a._id, quantity: 1 }])).toMatchObject({ outcome: 'total_changed', expected: 2000, actual: 1000 });
		expect((await edit(order, [{ productId: b._id, quantity: 2 }], { expectedRevision: 3 })).outcome).toBe('changed');
		expect((await edit(order, [{ productId: a._id, quantity: 2 }])).outcome).toBe('unchanged');
		expect((await findOrder(order._id)).itemsRevision).toBe(0);
		expect(await movements({ type: 'order_edit' })).toHaveLength(0);

		await transition(order._id, 'delivered');
		expect((await edit(order, [{ productId: b._id, quantity: 2 }])).outcome).toBe('final');
	});

	it('records no movement for an order that never took stock', async () => {
		const [a, b] = [await makeProduct(), await makeProduct()];
		const order = await placeOrder([lineOf(a, 2)], { stockDeducted: false });

		const result = await edit(order, [{ productId: b._id, quantity: 2 }]);

		expect(result.outcome).toBe('ok');
		expect(await movements({ type: 'order_edit' })).toHaveLength(0);
	});

	it('lets one of two edits from the same revision win and tells the other it changed', async () => {
		for (let round = 0; round < 10; round += 1) {
			const { a, b, order } = await setup();

			const results = await Promise.all([
				edit(order, [{ productId: a._id, quantity: 1 }, { productId: b._id, quantity: 1 }]),
				edit(order, [{ productId: b._id, quantity: 2 }])
			]);

			expect(outcomes(results), `round ${round}`).toEqual(['changed', 'ok']);
			const winner = results.find((result) => result.outcome === 'ok');
			const stored = await findOrder(winner.order._id);
			expect(stored.totalAmount).toBe(2000);
			expect(stored.itemsRevision).toBe(1);
			expect(stored.itemsHistory).toHaveLength(1);
			expect(units(stored)).toEqual(units(winner.order));
			const differences = await movements({ type: 'order_edit' });
			const net = differences.reduce((sum, movement) => sum + movement.delta, 0);
			expect(net, `round ${round}`).toBe(0);
		}
	});
});

describe('notes', () => {
	it('appends internal notes in order and edits the customer note', async () => {
		const order = await placeOrder([lineOf(await makeProduct())]);

		await orders.updateNotes({ orderId: order._id, internalNote: { note: 'first', by: 'admin', at: new Date('2026-10-01T00:00:00.000Z') } });
		const updated = await orders.updateNotes({ orderId: order._id, additionalNote: '  giao sau ', internalNote: { note: 'second', by: 'seller' } });

		expect(updated.additionalNote).toBe('giao sau');
		expect(updated.internalNotes.map((entry) => entry.note)).toEqual(['first', 'second']);
		expect((await findOrder(order._id)).internalNotes.map((entry) => entry.by)).toEqual(['admin', 'seller']);
	});

	it('keeps every note when many are added at the same time', async () => {
		const order = await placeOrder([lineOf(await makeProduct())]);

		await Promise.all(Array.from({ length: 12 }, (_, i) => orders.updateNotes({ orderId: order._id, internalNote: { note: `note ${i}`, by: 'admin' } })));

		const stored = await findOrder(order._id);
		expect(stored.internalNotes).toHaveLength(12);
		expect(new Set(stored.internalNotes.map((entry) => entry.note)).size).toBe(12);
	});

	it('answers null for an unknown order and stores nothing for an invalid note', async () => {
		const order = await placeOrder([lineOf(await makeProduct())]);

		expect(await orders.updateNotes({ orderId: newId(), additionalNote: 'x' })).toBeNull();
		await expect(orders.updateNotes({ orderId: order._id, internalNote: { note: '  ', by: 'admin' } })).rejects.toBeInstanceOf(RecordValidationError);
		await expect(orders.updateNotes({ orderId: order._id, additionalNote: 'x'.repeat(501) })).rejects.toBeInstanceOf(RecordValidationError);
		expect((await findOrder(order._id)).internalNotes).toEqual([]);
	});
});

describe('order, cancel and apply loops', () => {
	it('leaves the stock exactly equal to the units live orders hold after 60 orders, 15 cancels and every apply racing', async () => {
		const products = [await makeProduct(), await makeProduct(), await makeProduct()];
		const plan = Array.from({ length: 60 }, (_, i) => ({ product: products[i % 3], quantity: (i % 3) + 1, cancel: i % 4 === 0 }));

		const placed = await inWaves(plan, 10, (entry) => placeOrder([lineOf(entry.product, entry.quantity)]).then((order) => ({ ...entry, order })));
		const createMovements = await movements({ type: 'order' });
		expect(createMovements).toHaveLength(60);

		// Cancels and the appliers of the create movements run together.
		const cancelResults = inWaves(placed.filter((entry) => entry.cancel), 5, (entry) => transition(entry.order._id, 'cancelled'));
		const applied = inWaves(createMovements, 10, (movement) => applyUntilDone(movement._id));
		const [cancelled] = await Promise.all([cancelResults, applied]);
		expect(cancelled.every((result) => result.outcome === 'ok')).toBe(true);
		await applyAllPending();

		expect(await movements({ status: 'pending' })).toHaveLength(0);
		expect(await movements({ type: 'order_cancel' })).toHaveLength(15);
		expect(await countRows('movement')).toBe(60 + 15);
		for (const entry of placed) {
			const stored = await findOrder(entry.order._id);
			expect(stored.status).toBe(entry.cancel ? 'cancelled' : 'confirmed');
			expect(stored.stockDeducted).toBe(!entry.cancel);
		}
		for (const product of products) {
			const held = placed.filter((entry) => entry.product === product && !entry.cancel).reduce((sum, entry) => sum + entry.quantity, 0);
			expect(await stockOf(product._id)).toBe(0 - held);
		}
		expect(await withTransaction((tx) => reconcile({ tx }))).toEqual([]);
	});

	it('survives racing cancel and delivery of 50 orders without a lost or doubled return', async () => {
		const product = await makeProduct();
		const placed = await inWaves(Array.from({ length: 50 }, () => 1), 10, () => placeOrder([lineOf(product, 1)]));
		await applyAllPending();

		const results = await inWaves(placed, 5, (order) => Promise.all([transition(order._id, 'cancelled'), transition(order._id, 'delivered')]));
		await applyAllPending();

		let cancelled = 0;
		for (const [index, [cancel, delivery]] of results.entries()) {
			expect(outcomes([cancel, delivery]), `order ${index}`).toEqual(['final', 'ok']);
			const stored = await findOrder(placed[index]._id);
			expect(cancel.outcome === 'ok', `order ${index}`).toBe(stored.status === 'cancelled');
			expect(delivery.outcome === 'ok', `order ${index}`).toBe(stored.status === 'delivered');
			if (stored.status === 'cancelled') cancelled += 1;
		}
		expect(await movements({ type: 'order_cancel' })).toHaveLength(cancelled);
		expect(await movements({ type: 'order' })).toHaveLength(50);
		expect(await countRows('movement')).toBe(50 + cancelled);
		expect(await stockOf(product._id)).toBe(0 - (50 - cancelled));
	});
});
