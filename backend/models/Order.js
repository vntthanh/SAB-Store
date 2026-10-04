const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');

// A cancelled or delivered order never changes status again; only notes stay editable.
const FINAL_ORDER_STATUSES = ['cancelled', 'delivered'];

// Schema for status history tracking
const statusHistorySchema = new mongoose.Schema({
	status: {
		type: String,
		required: true,
		enum: ['confirmed', 'paid', 'delivered', 'cancelled']
	},
	updatedBy: {
		type: String,
		required: true // Username of who made the change
	},
	updatedAt: {
		type: Date,
		default: Date.now
	},
	transactionCode: {
		type: String,
		trim: true
	},
	cancelReason: {
		type: String,
		trim: true
	},
	note: {
		type: String,
		trim: true,
		maxLength: [500, 'Ghi chú không được vượt quá 500 ký tự']
	}
});

const orderItemSchema = new mongoose.Schema({
	productId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Product',
		required: true
	},
	productName: {
		type: String,
		required: true
	},
	price: {
		type: Number,
		required: true,
		min: 0
	},
	quantity: {
		type: Number,
		required: true,
		min: 1
	},
	// Per-line combo attribution. Subdocuments are strict: a field missing from
	// this schema is silently dropped on save.
	fromCombo: {
		type: Boolean,
		default: false
	},
	comboId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Combo',
		default: null
	},
	comboName: {
		type: String,
		trim: true,
		default: null
	}
});

const orderSchema = new mongoose.Schema({
	phoneNumber: {
		type: String,
		required: function () {
			return !this.isDirectSale;
		},
		trim: true,
		match: [/^0[0-9]{9}$/, 'Số điện thoại không hợp lệ'],
		maxLength: [10, 'Số điện thoại không được vượt quá 10 ký tự']
	},
	orderCode: {
		type: String,
		required: true,
		unique: true,
		uppercase: true,
		maxLength: 10  // Increased from length: 5 to accommodate both formats
	},
	orderNumber: {
		type: String,
		unique: true,
		sparse: true // Allow null values but enforce uniqueness when present
	},
	studentId: {
		type: String,
		required: function () {
			return !this.isDirectSale;
		},
		trim: true,
		maxLength: [20, 'Mã số sinh viên không được vượt quá 20 ký tự']
	},
	fullName: {
		type: String,
		required: function () {
			return !this.isDirectSale;
		},
		trim: true,
		maxLength: [100, 'Họ tên không được vượt quá 100 ký tự']
	},
	email: {
		type: String,
		required: function () {
			return !this.isDirectSale;
		},
		trim: true,
		lowercase: true,
		validate: {
			validator: function (v) {
				// Skip validation for direct sales or empty values
				if (this.isDirectSale || !v) return true;
				return /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(v);
			},
			message: 'Email không hợp lệ'
		}
	},
	additionalNote: {
		type: String,
		trim: true,
		maxLength: [500, 'Ghi chú không được vượt quá 500 ký tự']
	},
	items: [orderItemSchema],
	totalAmount: {
		type: Number,
		required: true,
		min: 0
	},
	status: {
		type: String,
		// 'pending' removed (Q3): production never defaults to it (this field
		// defaults to 'confirmed') and no route accepts it as a target status
		// (see middleware/validation.js's validateOrderUpdate). Existing
		// documents that predate this change, if any, are unaffected: Mongoose
		// update validators only check paths present in a given update, so a
		// stale 'pending' value that isn't itself the field being written is
		// never re-validated — see routes' use of findOneAndUpdate/
		// findByIdAndUpdate instead of load-then-save for every status
		// status transition.
		enum: ['confirmed', 'paid', 'delivered', 'cancelled'],
		default: 'confirmed'
	},
	// True while this order holds a deduction against the stock ledger: set at
	// creation (online and counter) and cleared when a cancel gives the units back.
	// It alone decides whether a cancel records a movement, so a cancel never
	// returns units that were never taken and never returns them twice. Orders
	// created before stock was tracked per order keep `false`: cancelling them
	// records nothing, since nothing was taken.
	stockDeducted: {
		type: Boolean,
		default: false,
		required: true
	},
	transactionCode: {
		type: String,
		trim: true,
		maxLength: [50, 'Mã giao dịch không được vượt quá 50 ký tự']
	},
	cancelReason: {
		type: String,
		trim: true,
		maxLength: [500, 'Lý do hủy không được vượt quá 500 ký tự']
	},
	statusHistory: [statusHistorySchema], // Track all status changes
	// Admin-only notes, kept apart from statusHistory: both dashboards render every
	// statusHistory entry as a status event and cancel idempotency keys use its length.
	// Never returned to sellers or the public lookup.
	internalNotes: [{
		note: {
			type: String,
			required: true,
			trim: true,
			maxlength: [500, 'Ghi chú không được vượt quá 500 ký tự']
		},
		by: { type: String, required: true },
		at: { type: Date, default: Date.now },
		_id: false
	}],
	// Bumped by every admin edit of `items`; the edit's compare-and-set key. Orders
	// stored before it existed lack the field, so readers treat a missing value as 0.
	itemsRevision: {
		type: Number,
		default: 0
	},
	// One entry per admin edit of `items`, holding the set it replaced. Admin-only
	// and heavy (whole item sets): excluded from lists and every seller read.
	itemsHistory: [{
		previousItems: { type: mongoose.Schema.Types.Mixed, default: [] },
		previousComboInfo: { type: mongoose.Schema.Types.Mixed, default: null },
		editedBy: { type: String, required: true },
		editedAt: { type: Date, default: Date.now },
		reason: {
			type: String,
			required: true,
			trim: true,
			maxlength: [200, 'Lý do không được vượt quá 200 ký tự']
		},
		_id: false
	}],
	lastUpdatedBy: {
		type: String,
		default: 'system' // Username of who last updated the order
	},
	statusUpdatedAt: {
		type: Date,
		default: Date.now
	},
	// Direct sale specific fields
	isDirectSale: {
		type: Boolean,
		default: false
	},
	createdBy: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User'
	},
	// Combo pricing information
	comboInfo: {
		type: mongoose.Schema.Types.Mixed,
		default: null
	}
}, {
	timestamps: true
});

// Indexes for better search performance  
// Note: orderCode and orderNumber already have unique indexes from schema definition
orderSchema.index({ studentId: 1 });
orderSchema.index({ email: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ isDirectSale: 1 });
orderSchema.index({ fullName: 'text', studentId: 'text', orderCode: 'text', orderNumber: 'text' });

// statusHistory has exactly one writer: the route performing the transition
// pushes its own entry explicitly (via $push on findOneAndUpdate/
// findByIdAndUpdate, or in the initial array on creation). This hook used to
// *also* push an entry whenever an existing document's status changed via
// `.save()`, which duplicated every entry a route wrote by hand before
// saving — every status-changing route in this codebase now goes through an
// atomic findOneAndUpdate/findByIdAndUpdate instead of load-then-save, so
// that duplication path is gone. What remains here is only the
// `statusUpdatedAt` bump, kept as a safety net for any future `.save()` on
// an existing order with a modified status.
orderSchema.pre('save', function (next) {
	if (this.isModified('status') && !this.isNew) {
		this.statusUpdatedAt = new Date();
	}
	next();
});

orderSchema.plugin(mongoosePaginate);
const Order = mongoose.model('Order', orderSchema);
Order.FINAL_ORDER_STATUSES = FINAL_ORDER_STATUSES;

module.exports = Order;
