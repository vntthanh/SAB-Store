/**
 * A store with every shape a backup has to bring back: products with applied
 * and pending stock movements (opening, order, order_cancel, order_edit, adjust),
 * two combos sharing a name, a combo order, a direct sale, a cancelled order with
 * its status history, an edited order with its edit history, an order with
 * internal notes, and the settings row.
 *
 * The ledger rows go through the real service, so every product's cache equals
 * the sum of its applied movements, as in a live store. Tests assert on what the
 * database holds through helpers/db.js.
 */
const { recordMovement, recordAppliedOpening } = require('../../services/stock-ledger');
const { makeProduct, makeCombo, makeOrder, makeSettings } = require('../helpers/factories');
const { applyPendingMovements } = require('../helpers/stock');
const {
	listProducts, listCombos, listOrders, movements, findSettings
} = require('../helpers/db');

let keySeq = 0;
const key = (label) => `fixture:${label}:${++keySeq}`;

/**
 * @param {string} tag keeps names and codes of two seeded stores apart
 */
async function seedStore(tag = 'a') {
	const lanyard = await makeProduct({ name: `Lanyard ${tag}`, category: `lanyard-${tag}`, price: 40000, stockQuantity: 10 });
	await recordAppliedOpening({ productId: lanyard._id, quantity: 10, createdBy: 'seed', reason: 'seed' });
	const badge = await makeProduct({ name: `Badge ${tag}`, category: `badge-${tag}`, price: 25000, stockQuantity: 0, salePrice: 20000, tags: ['pin', 'new'] });
	const sticker = await makeProduct({ name: `Sticker ${tag}`, category: `sticker-${tag}`, price: 5000, stockQuantity: 0 });

	const comboA = await makeCombo({ name: `Twin combo ${tag}`, price: 60000, categoryRequirements: [{ category: `lanyard-${tag}`, quantity: 1 }, { category: `badge-${tag}`, quantity: 1 }] });
	const comboB = await makeCombo({ name: `Twin combo ${tag}`, price: 30000, isActive: false, categoryRequirements: [{ category: `sticker-${tag}`, quantity: 2 }] });

	// A combo order: the combo lines keep retail prices, the total is the combo's charge plus the plain line.
	const comboOrder = await makeOrder({
		orderCode: `C${tag.toUpperCase()}0001`,
		items: [
			{ productId: lanyard._id, productName: lanyard.name, price: 40000, quantity: 1, fromCombo: true, comboId: comboA._id, comboName: comboA.name },
			{ productId: badge._id, productName: badge.name, price: 25000, quantity: 1, fromCombo: true, comboId: comboA._id, comboName: comboA.name },
			{ productId: sticker._id, productName: sticker.name, price: 5000, quantity: 2 }
		],
		totalAmount: 60000 + 10000,
		comboInfo: {
			savings: 5000,
			originalTotal: 65000,
			finalTotal: 60000,
			combos: [{ comboId: comboA._id, comboName: comboA.name, applications: 1, savings: 5000 }]
		},
		internalNotes: [{ note: 'Khách hẹn lấy thứ Sáu', by: 'admin', at: new Date('2026-10-02T03:04:05.000Z') }],
		additionalNote: 'Giao tại cơ sở 1'
	});

	const directSale = await makeOrder({
		orderCode: `D${tag.toUpperCase()}0002`,
		isDirectSale: true,
		phoneNumber: undefined,
		studentId: undefined,
		fullName: undefined,
		email: undefined,
		items: [{ productId: sticker._id, productName: sticker.name, price: 5000, quantity: 3 }],
		totalAmount: 15000,
		status: 'paid',
		lastUpdatedBy: 'seller-1'
	});

	const cancelled = await makeOrder({
		orderCode: `X${tag.toUpperCase()}0003`,
		items: [{ productId: lanyard._id, productName: lanyard.name, price: 40000, quantity: 3 }],
		totalAmount: 120000,
		status: 'cancelled',
		cancelReason: 'Khách đổi ý',
		stockDeducted: false,
		statusHistory: [
			{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date('2026-10-01T01:00:00.000Z') },
			{ status: 'cancelled', updatedBy: 'admin', updatedAt: new Date('2026-10-01T02:00:00.000Z'), note: 'gọi không được', cancelReason: 'Khách đổi ý' }
		]
	});

	const edited = await makeOrder({
		orderCode: `E${tag.toUpperCase()}0004`,
		items: [{ productId: badge._id, productName: badge.name, price: 25000, quantity: 2 }],
		totalAmount: 50000,
		itemsRevision: 1,
		itemsHistory: [{
			previousItems: [{ _id: comboOrder.items[0]._id, productId: sticker._id, productName: sticker.name, price: 25000, quantity: 2, fromCombo: false, comboId: null, comboName: null }],
			previousComboInfo: null,
			editedBy: 'admin',
			editedAt: new Date('2026-10-03T03:00:00.000Z'),
			reason: 'Đổi sang huy hiệu'
		}]
	});

	// Applied ledger rows: the real worker moves each cache by its delta.
	const withOrder = (productId, orderId) => ({ productId, orderId });
	await recordMovement({ ...withOrder(lanyard._id, comboOrder._id), type: 'order', delta: -1, idempotencyKey: key('order') });
	await recordMovement({ ...withOrder(lanyard._id, cancelled._id), type: 'order', delta: -3, idempotencyKey: key('order') });
	await recordMovement({ ...withOrder(lanyard._id, cancelled._id), type: 'order_cancel', delta: 3, idempotencyKey: key('cancel') });
	await recordMovement({ ...withOrder(badge._id, edited._id), type: 'order_edit', delta: -2, idempotencyKey: key('edit'), reason: `Sửa đơn ${edited.orderCode}` });
	await recordMovement({ productId: badge._id, type: 'adjust', delta: 9, reason: 'kiểm kê', createdBy: 'admin', idempotencyKey: key('adjust') });
	await applyPendingMovements();

	// Pending rows stay pending: they are not in any cache yet.
	await recordMovement({ productId: sticker._id, type: 'adjust', delta: 20, createdBy: 'admin', idempotencyKey: key('pending-adjust') });
	await recordMovement({ productId: sticker._id, type: 'set_target', target: 50, createdBy: 'admin', idempotencyKey: key('pending-target') });

	await makeSettings({
		bankNameId: 'MB',
		bankAccountId: `0123456${tag === 'a' ? '789' : '000'}`,
		storeTitle: `SAB Store ${tag}`,
		prefixMessage: 'SAB',
		checkoutNotice: 'Kiểm tra kỹ thông tin',
		eventNotice: '',
		paymentNotice: `Thanh toán trong 1 giờ (${tag})`,
		contactEmail: `contact-${tag}@example.com`,
		contactFacebookUrl: `https://example.com/${tag}`,
		updatedBy: 'admin'
	});

	return { products: { lanyard, badge, sticker }, combos: { comboA, comboB }, orders: { comboOrder, directSale, cancelled, edited } };
}

/** Everything a restore replaces, as the database holds it (hex ids, no `__v`). */
async function readStore() {
	return {
		products: await listProducts(),
		combos: await listCombos(),
		orders: await listOrders(),
		movements: await movements(),
		settings: await findSettings()
	};
}

module.exports = { seedStore, readStore };
