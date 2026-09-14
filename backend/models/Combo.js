const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');

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
		min: [0, 'Giá không được âm']
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
	priority: {
		type: Number,
		default: 0,
		comment: 'Độ ưu tiên combo, số cao hơn được ưu tiên áp dụng trước'
	}
}, {
	timestamps: true
});

// Index for better performance
comboSchema.index({ isActive: 1 });
comboSchema.index({ priority: -1 });
comboSchema.index({ createdAt: -1 });

// Virtual for total required quantity
comboSchema.virtual('totalRequiredQuantity').get(function () {
	return this.categoryRequirements.reduce((total, req) => total + req.quantity, 0);
});

// Static method to find active combos
comboSchema.statics.findActive = function (filter = {}) {
	return this.find({ ...filter, isActive: true }).sort({ priority: -1, createdAt: -1 });
};

// Method to check if products can satisfy this combo
comboSchema.methods.canApplyToProducts = function (products) {
	const productsByCategory = {};

	// Group products by category
	products.forEach(item => {
		if (!productsByCategory[item.product.category]) {
			productsByCategory[item.product.category] = 0;
		}
		productsByCategory[item.product.category] += item.quantity;
	});

	// Check if all category requirements are met
	return this.categoryRequirements.every(requirement => {
		const availableQuantity = productsByCategory[requirement.category] || 0;
		return availableQuantity >= requirement.quantity;
	});
};

// Method to calculate savings compared to individual product prices
comboSchema.methods.calculateSavings = function (products) {
	const individualTotal = products.reduce((total, item) => {
		return total + (item.product.price * item.quantity);
	}, 0);

	return Math.max(0, individualTotal - this.price);
};

// Method to calculate maximum number of times this combo can be applied
//
// Starts the running minimum at Infinity, not 0: the old code seeded it with
// the first requirement's result, so a requirement met by 0 available items
// set max=0 but the *next* requirement's Math.min(0, x) === 0 branch was
// never taken — the `if (maxApplications === 0)` guard treated that 0 as
// "unset" and overwrote it with the next requirement's count instead of
// keeping it pinned at 0. A combo needing 1xA + 1xB with 0xA in the cart
// would then apply as if only B was required. Breaking as soon as a 0 shows
// up also avoids evaluating requirements that can no longer change the
// result.
comboSchema.methods.getMaxApplications = function (products) {
	const productsByCategory = {};

	// Group products by category
	products.forEach(item => {
		if (!productsByCategory[item.product.category]) {
			productsByCategory[item.product.category] = 0;
		}
		productsByCategory[item.product.category] += item.quantity;
	});

	let maxApplications = Infinity;

	for (const requirement of this.categoryRequirements) {
		const availableQuantity = productsByCategory[requirement.category] || 0;
		const possibleApplications = Math.floor(availableQuantity / requirement.quantity);
		maxApplications = Math.min(maxApplications, possibleApplications);
		if (maxApplications === 0) break;
	}

	// A combo with no requirements (schema forbids this, but stay defensive)
	// must not report Infinity applications.
	return maxApplications === Infinity ? 0 : maxApplications;
};

// Method to calculate total savings with maximum applications
comboSchema.methods.calculateMaxSavings = function (products) {
	const maxApplications = this.getMaxApplications(products);
	if (maxApplications <= 0) return 0;

	// Calculate cost if all applicable items are in combos
	const comboTotal = maxApplications * this.price;

	// Calculate the cost of items used in combos at individual prices
	const productsByCategory = {};
	products.forEach(item => {
		if (!productsByCategory[item.product.category]) {
			productsByCategory[item.product.category] = [];
		}
		productsByCategory[item.product.category].push(item);
	});

	let usedItemsCost = 0;
	for (const requirement of this.categoryRequirements) {
		const categoryItems = productsByCategory[requirement.category] || [];
		let remainingNeeded = requirement.quantity * maxApplications;

		// Sort by price (highest first) to use most expensive items in combo
		categoryItems.sort((a, b) => b.product.price - a.product.price);

		for (const item of categoryItems) {
			if (remainingNeeded <= 0) break;

			const useQuantity = Math.min(item.quantity, remainingNeeded);
			usedItemsCost += useQuantity * item.product.price;
			remainingNeeded -= useQuantity;
		}
	}

	return Math.max(0, usedItemsCost - comboTotal);
};

// Static method to find optimal combo combination
//
// Accepts an optional preloaded combo list so a caller applying several
// combos in a loop (ComboService.calculateOptimalPricing, pricing.js) can
// query Combo.findActive() once and reuse it, instead of re-querying on
// every iteration.
comboSchema.statics.findOptimalCombination = async function (products, preloadedCombos = null) {
	const activeCombos = preloadedCombos || await this.findActive();

	// Calculate savings for each combo
	const comboAnalysis = activeCombos.map(combo => ({
		combo,
		maxApplications: combo.getMaxApplications(products),
		savingsPerApplication: combo.calculateSavings(products),
		totalSavings: combo.calculateMaxSavings(products)
	}));

	// Filter out combos that can't be applied
	const applicableCombos = comboAnalysis.filter(analysis => analysis.maxApplications > 0);

	// Sort by total savings (highest first), then by priority
	applicableCombos.sort((a, b) => {
		if (b.totalSavings !== a.totalSavings) {
			return b.totalSavings - a.totalSavings;
		}
		return b.combo.priority - a.combo.priority;
	});

	return applicableCombos;
};

// Add pagination plugin
comboSchema.plugin(mongoosePaginate);

module.exports = mongoose.model('Combo', comboSchema);
