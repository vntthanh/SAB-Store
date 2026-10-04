const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');

// Where a product (or combo) may be sold. 'all' is not a channel a sale happens
// on; it is a product allowing every channel.
const SALES_CHANNELS = ['all', 'online', 'offline'];
const SALE_CHANNELS = ['online', 'offline'];

function assertSaleChannel(channel) {
	if (!SALE_CHANNELS.includes(channel)) {
		throw new TypeError(`channel must be one of ${SALE_CHANNELS.join(', ')}; got ${String(channel)}`);
	}
}

// Documents written before salesChannel existed have no such key, and Mongoose
// defaults do not apply to queries, so a bare $in would silently drop them.
function channelClause(channel) {
	assertSaleChannel(channel);
	return { $or: [{ salesChannel: { $in: ['all', channel] } }, { salesChannel: { $exists: false } }] };
}

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
		min: [0, 'Giá không được âm']
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
	stockQuantity: {
		type: Number,
		default: 0,
		min: [0, 'Số lượng tồn kho không được âm']
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

// The one rule for "can be sold on this channel". Every list or lookup that
// feeds a sale or a storefront goes through here so the channels cannot drift.
productSchema.statics.sellableQuery = function (channel) {
	return { available: true, ...channelClause(channel) };
};

// $and keeps a caller filter's own $or (e.g. text search) from colliding with
// the channel $or.
productSchema.statics.findSellable = function (channel, filter = {}) {
	return this.find({ $and: [filter, this.sellableQuery(channel)] });
};

productSchema.statics.findFeatured = function (channel, limit = 6) {
	return this.findSellable(channel, { featured: true }).limit(limit);
};

// Add pagination plugin
productSchema.plugin(mongoosePaginate);

const Product = mongoose.model('Product', productSchema);
Product.SALES_CHANNELS = SALES_CHANNELS;
Product.channelClause = channelClause;

module.exports = Product;
