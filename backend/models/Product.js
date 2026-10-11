const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');
const { publicCodePlugin } = require('../utils/public-code');
const { SALES_CHANNELS, productSellableFilter } = require('../data/mongo/sellable');

const productSchema = new mongoose.Schema({
	name: {
		type: String,
		required: [true, 'Tên sản phẩm là bắt buộc'],
		trim: true,
		maxLength: [100, 'Tên sản phẩm không được vượt quá 100 ký tự']
	},
	description: {
		type: String,
		trim: true,
		maxLength: [500, 'Mô tả không được vượt quá 500 ký tự']
	},
	price: {
		type: Number,
		required: [true, 'Giá sản phẩm là bắt buộc'],
		min: [0, 'Giá không được âm'],
		// A fractional price makes every order total fractional, and a client
		// can only echo an integer total back, so each order would fail as 409.
		validate: { validator: Number.isInteger, message: 'Giá phải là số nguyên (VND)' }
	},
	imageUrl: {
		type: String,
		default: '/fallback-product.png'
	},
	category: {
		type: String,
		required: [true, 'Danh mục sản phẩm là bắt buộc']
	},
	available: {
		type: Boolean,
		default: true
	},
	// Deprecated: nothing reads this any more; `available` is the only on/off
	// switch. Kept so existing documents and old backup files still load.
	isActive: {
		type: Boolean,
		default: true
	},
	salesChannel: {
		type: String,
		enum: SALES_CHANNELS,
		default: 'all'
	},
	// A cache of the stock ledger, written only by the ledger worker. No `min`:
	// an order is never refused for lack of stock, so the sum can legitimately go
	// negative until the shelf is restocked and counted.
	stockQuantity: {
		type: Number,
		default: 0
	},
	minOrderQuantity: {
		type: Number,
		default: 1,
		min: [1, 'Số lượng đặt hàng tối thiểu phải >= 1']
	},
	maxOrderQuantity: {
		type: Number,
		default: null
	},
	sku: {
		type: String,
		trim: true,
		unique: true,
		sparse: true
	},
	tags: [{
		type: String,
		trim: true
	}],
	weight: {
		type: Number,
		min: [0, 'Trọng lượng không được âm']
	},
	dimensions: {
		length: Number,
		width: Number,
		height: Number
	},
	featured: {
		type: Boolean,
		default: false
	},
	salePrice: {
		type: Number,
		min: [0, 'Giá khuyến mãi không được âm']
	},
	saleStartDate: {
		type: Date
	},
	saleEndDate: {
		type: Date
	}
}, {
	timestamps: true
});

// Index for better search performance
productSchema.index({ name: 'text', description: 'text' });
productSchema.index({ category: 1 });
productSchema.index({ available: 1 });
productSchema.index({ salesChannel: 1 });
productSchema.index({ featured: 1 });
productSchema.index({ createdAt: -1 });

// Virtual for current price (considering sale)
productSchema.virtual('currentPrice').get(function () {
	const now = new Date();
	if (this.salePrice &&
		this.saleStartDate &&
		this.saleEndDate &&
		now >= this.saleStartDate &&
		now <= this.saleEndDate) {
		return this.salePrice;
	}
	return this.price;
});

// Virtual for sale status
productSchema.virtual('onSale').get(function () {
	const now = new Date();
	return !!(this.salePrice &&
		this.saleStartDate &&
		this.saleEndDate &&
		now >= this.saleStartDate &&
		now <= this.saleEndDate);
});

// Virtual for stock status
productSchema.virtual('inStock').get(function () {
	return this.stockQuantity > 0;
});

// Query form of the sellable rule (data/mongo/sellable.js) for routes that
// chain their own sort and paging onto it.
productSchema.statics.findSellable = function (channel, filter = {}) {
	return this.find(productSellableFilter(channel, filter));
};

// Add pagination plugin
productSchema.plugin(mongoosePaginate);
productSchema.plugin(publicCodePlugin);

const Product = mongoose.model('Product', productSchema);
Product.SALES_CHANNELS = SALES_CHANNELS;

module.exports = Product;
