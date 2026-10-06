const mongoose = require('mongoose');

const MOVEMENT_TYPES = ['opening', 'order', 'order_cancel', 'order_edit', 'adjust', 'set_target'];
const MOVEMENT_STATUSES = ['pending', 'applied'];

/**
 * One signed change to a product's stock. `Product.stockQuantity` is a cache of
 * the sum of `delta` over this product's `applied` movements; the movements are
 * the source of truth, which is what makes the cache re-derivable.
 *
 * A movement is written `pending` in the same transaction as whatever caused it
 * (an order, an admin action) and flipped to `applied` by the ledger worker, so
 * a crash or a lost queue job can only delay the cache, never lose a change.
 */
const stockMovementSchema = new mongoose.Schema({
	productId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Product',
		required: true
	},
	type: {
		type: String,
		enum: MOVEMENT_TYPES,
		required: true
	},
	// For `set_target` this stays null until the worker applies it: the delta
	// depends on the stock at apply time, which is only known then.
	delta: {
		type: Number,
		default: null
	},
	// Only meaningful for `set_target`.
	target: {
		type: Number,
		default: null
	},
	orderId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Order',
		default: null
	},
	reason: {
		type: String,
		trim: true,
		maxLength: 200,
		default: ''
	},
	createdBy: {
		type: String,
		trim: true,
		maxLength: 200,
		default: ''
	},
	// Resending the same logical change must not double it, e.g.
	// `order:<orderId>:<productId>:create`.
	idempotencyKey: {
		type: String,
		required: true,
		maxLength: 200
	},
	status: {
		type: String,
		enum: MOVEMENT_STATUSES,
		default: 'pending'
	},
	appliedAt: {
		type: Date,
		default: null
	},
	stockAfter: {
		type: Number,
		default: null
	},
	claimedAt: {
		type: Date,
		default: null
	},
	attempts: {
		type: Number,
		default: 0
	},
	lastError: {
		type: String,
		default: null
	}
}, {
	timestamps: { createdAt: true, updatedAt: false }
});

stockMovementSchema.index({ idempotencyKey: 1 }, { unique: true });
// Per-product apply order (createdAt, _id) and the "any older pending?" probe.
stockMovementSchema.index({ productId: 1, status: 1, createdAt: 1, _id: 1 });
// The sweeper scans pending movements across all products by age; the partial
// filter keeps this index tiny because almost every movement is applied.
stockMovementSchema.index(
	{ createdAt: 1, _id: 1 },
	{ partialFilterExpression: { status: 'pending' }, name: 'pending_by_age' }
);

module.exports = mongoose.model('StockMovement', stockMovementSchema);
module.exports.MOVEMENT_TYPES = MOVEMENT_TYPES;
