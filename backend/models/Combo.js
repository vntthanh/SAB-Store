const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');
const Product = require('./Product');

const categoryRequirementSchema = new mongoose.Schema({
	category: {
		type: String,
		required: [true, 'Danh mục là bắt buộc'],
		trim: true
	},
	quantity: {
		type: Number,
		required: [true, 'Số lượng là bắt buộc'],
		min: [1, 'Số lượng phải >= 1']
	}
});

const comboSchema = new mongoose.Schema({
	name: {
		type: String,
		required: [true, 'Tên combo là bắt buộc'],
		trim: true,
		maxLength: [100, 'Tên combo không được vượt quá 100 ký tự']
	},
	description: {
		type: String,
		trim: true,
		maxLength: [500, 'Mô tả không được vượt quá 500 ký tự']
	},
	price: {
		type: Number,
		required: [true, 'Giá combo là bắt buộc'],
		min: [0, 'Giá không được âm'],
		// Integer VND only: see the matching validator on Product.price.
		validate: { validator: Number.isInteger, message: 'Giá phải là số nguyên (VND)' }
	},
	categoryRequirements: {
		type: [categoryRequirementSchema],
		required: [true, 'Yêu cầu danh mục là bắt buộc'],
		validate: {
			validator: function (v) {
				return v && v.length > 0;
			},
			message: 'Combo phải có ít nhất một yêu cầu danh mục'
		}
	},
	isActive: {
		type: Boolean,
		default: true
	},
	salesChannel: {
		type: String,
		enum: Product.SALES_CHANNELS,
		default: 'all'
	},
	priority: {
		type: Number,
		default: 0,
		comment: 'Độ ưu tiên combo, số cao hơn được ưu tiên áp dụng trước'
	}
}, {
	timestamps: true
});

// Index for better performance
// Serves the sellable-combo query: equality on isActive, ordered by priority.
comboSchema.index({ isActive: 1, priority: -1, createdAt: -1 });
comboSchema.index({ priority: -1 });
comboSchema.index({ createdAt: -1 });

// Virtual for total required quantity
comboSchema.virtual('totalRequiredQuantity').get(function () {
	return this.categoryRequirements.reduce((total, req) => total + req.quantity, 0);
});

// Combos that may discount an order placed on `channel`. The products inside a
// combo must still be sellable on that channel; pricing checks that separately.
comboSchema.statics.findSellable = function (channel) {
	return this.find({ $and: [{ isActive: true }, Product.channelClause(channel)] })
		.sort({ priority: -1, createdAt: -1 });
};

// Add pagination plugin
comboSchema.plugin(mongoosePaginate);

module.exports = mongoose.model('Combo', comboSchema);
