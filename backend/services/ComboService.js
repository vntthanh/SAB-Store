const Combo = require('../models/Combo');
const Product = require('../models/Product');

class ComboService {
	/**
	 * Calculate optimal pricing for cart items including combos
	 * @param {Array} items - Array of {productId, quantity}
	 * @returns {Object} Pricing breakdown with combos
	 */
	static async calculateOptimalPricing(items) {
		if (!items || items.length === 0) {
			return {
				originalTotal: 0,
				finalTotal: 0,
				totalSavings: 0,
				appliedCombos: [],
				remainingItems: [],
				breakdown: []
			};
		}

		// Get product details
		const productIds = items.map(item => item.productId);
		const products = await Product.find({ _id: { $in: productIds } });

		// Create products with quantities
		let remainingProducts = items.map(item => {
			const product = products.find(p => p._id.toString() === item.productId);
			return {
				productId: item.productId,
				product,
				quantity: item.quantity
			};
		}).filter(item => item.product);

		if (remainingProducts.length === 0) {
			return {
				originalTotal: 0,
				finalTotal: 0,
				totalSavings: 0,
				appliedCombos: [],
				remainingItems: [],
				breakdown: []
			};
		}

		const originalTotal = remainingProducts.reduce((total, item) => {
			return total + (item.product.price * item.quantity);
		}, 0);

		const appliedCombos = [];
		const breakdown = [];
		let currentTotal = 0;

		// Load active combos once, outside the loop: the old code called
		// Combo.findActive() (via findOptimalCombination) on every iteration,
		// one query per combo application instead of one per pricing pass.
		const activeCombos = await Combo.findActive();

		// Keep applying combos until no more beneficial combos can be applied
		while (remainingProducts.length > 0) {
			const optimalCombos = await Combo.findOptimalCombination(remainingProducts, activeCombos);

			if (optimalCombos.length === 0 || optimalCombos[0].totalSavings <= 0) {
				break; // No more beneficial combos
			}

			const bestCombo = optimalCombos[0];

			// Apply the best combo
			const comboApplication = this.applyComboToProducts(bestCombo, remainingProducts);

			if (comboApplication.applicationsUsed > 0) {
				appliedCombos.push({
					combo: bestCombo.combo,
					applications: comboApplication.applicationsUsed,
					itemsUsed: comboApplication.itemsUsed,
					totalPrice: comboApplication.applicationsUsed * bestCombo.combo.price,
					savings: comboApplication.savings
				});

				breakdown.push({
					type: 'combo',
					name: bestCombo.combo.name,
					applications: comboApplication.applicationsUsed,
					pricePerApplication: bestCombo.combo.price,
					totalPrice: comboApplication.applicationsUsed * bestCombo.combo.price,
					itemsUsed: comboApplication.itemsUsed,
					savings: comboApplication.savings
				});

				currentTotal += comboApplication.applicationsUsed * bestCombo.combo.price;

				// Update remaining products
				remainingProducts = comboApplication.remainingProducts;
			} else {
				break; // Can't apply any more combos
			}
		}

		// Add remaining items at individual prices
		const remainingTotal = remainingProducts.reduce((total, item) => {
			return total + (item.product.price * item.quantity);
		}, 0);

		if (remainingTotal > 0) {
			breakdown.push({
				type: 'individual',
				items: remainingProducts.map(item => ({
					productId: item.productId,
					productName: item.product.name,
					price: item.product.price,
					quantity: item.quantity,
					subtotal: item.product.price * item.quantity
				})),
				totalPrice: remainingTotal
			});
		}

		currentTotal += remainingTotal;

		return {
			originalTotal,
			finalTotal: currentTotal,
			totalSavings: originalTotal - currentTotal,
			appliedCombos,
			remainingItems: remainingProducts,
			breakdown
		};
	}

	/**
	 * Apply a specific combo to products and return updated state
	 * @param {Object} comboAnalysis - Combo analysis from findOptimalCombination
	 * @param {Array} products - Current products with quantities
	 * @returns {Object} Application result
	 */
	static applyComboToProducts(comboAnalysis, products) {
		const { combo, maxApplications } = comboAnalysis;

		if (maxApplications <= 0) {
			return {
				applicationsUsed: 0,
				itemsUsed: [],
				remainingProducts: products,
				savings: 0
			};
		}

		// Group products by category
		const productsByCategory = {};
		products.forEach(item => {
			if (!productsByCategory[item.product.category]) {
				productsByCategory[item.product.category] = [];
			}
			productsByCategory[item.product.category].push(item);
		});

		const itemsUsed = [];
		const remainingProducts = [...products];

		let totalUsedCost = 0;

		// Apply combo requirements
		for (const requirement of combo.categoryRequirements) {
			const categoryItems = productsByCategory[requirement.category] || [];
			let remainingNeeded = requirement.quantity * maxApplications;

			// Sort by price (highest first) to maximize savings
			categoryItems.sort((a, b) => b.product.price - a.product.price);

			for (const item of categoryItems) {
				if (remainingNeeded <= 0) break;

				const useQuantity = Math.min(item.quantity, remainingNeeded);

				if (useQuantity > 0) {
					itemsUsed.push({
						productId: item.productId,
						productName: item.product.name,
						category: item.product.category,
						price: item.product.price,
						quantity: useQuantity,
						subtotal: useQuantity * item.product.price
					});

					totalUsedCost += useQuantity * item.product.price;

					// Update remaining quantity
					const remainingItem = remainingProducts.find(p => p.productId === item.productId);
					if (remainingItem) {
						remainingItem.quantity -= useQuantity;
					}

					remainingNeeded -= useQuantity;
				}
			}
		}

		// Remove items with 0 quantity
		const filteredRemainingProducts = remainingProducts.filter(item => item.quantity > 0);

		const comboTotalCost = maxApplications * combo.price;
		const savings = totalUsedCost - comboTotalCost;

		// Post-condition: this loop must have consumed exactly
		// Σ(requirement.quantity × maxApplications) items. If it consumed
		// less (e.g. a category was short and the loop above ran out of
		// items to pull from), the combo was applied to a cart that could
		// not actually satisfy it — fail loudly instead of silently billing
		// the discounted price for fewer real items. getMaxApplications()
		// fixed above should make this unreachable; this is a defense against
		// the two methods drifting out of sync in the future.
		const expectedConsumed = combo.categoryRequirements.reduce(
			(total, requirement) => total + requirement.quantity * maxApplications,
			0
		);
		const actualConsumed = itemsUsed.reduce((total, item) => total + item.quantity, 0);
		if (actualConsumed !== expectedConsumed) {
			throw new Error(
				`Combo "${combo.name}" tiêu thụ ${actualConsumed} sản phẩm nhưng cần ${expectedConsumed} cho ${maxApplications} lượt áp dụng`
			);
		}

		return {
			applicationsUsed: maxApplications,
			itemsUsed,
			remainingProducts: filteredRemainingProducts,
			savings
		};
	}

	/**
	 * Get pricing breakdown for display
	 * @param {Array} items - Cart items
	 * @returns {Object} Formatted pricing info
	 */
	static async getPricingBreakdown(items) {
		const pricing = await this.calculateOptimalPricing(items);

		return {
			summary: {
				originalTotal: pricing.originalTotal,
				finalTotal: pricing.finalTotal,
				totalSavings: pricing.totalSavings,
				savingsPercentage: pricing.originalTotal > 0
					? ((pricing.totalSavings / pricing.originalTotal) * 100).toFixed(1)
					: 0
			},
			combos: pricing.appliedCombos.map(combo => ({
				name: combo.combo.name,
				applications: combo.applications,
				pricePerApplication: combo.combo.price,
				totalPrice: combo.totalPrice,
				savings: combo.savings,
				itemsUsed: combo.itemsUsed
			})),
			individualItems: pricing.remainingItems.map(item => ({
				productId: item.productId,
				productName: item.product.name,
				price: item.product.price,
				quantity: item.quantity,
				subtotal: item.product.price * item.quantity
			})),
			breakdown: pricing.breakdown
		};
	}

	/**
	 * Legacy method for backward compatibility
	 * @param {Array} items 
	 * @param {boolean} silent 
	 * @returns {Object}
	 */
	static async detectAndApplyBestCombo(items, silent = false) {
		const pricing = await this.calculateOptimalPricing(items);

		return {
			success: true,
			hasCombo: pricing.appliedCombos.length > 0,
			originalItems: items,
			finalItems: items, // For compatibility - items structure unchanged
			combo: pricing.appliedCombos.length > 0 ? pricing.appliedCombos[0].combo : null,
			savings: pricing.totalSavings,
			message: pricing.appliedCombos.length > 0
				? `Đã áp dụng combo tiết kiệm ${this.formatCurrency(pricing.totalSavings)}`
				: null,
			pricing
		};
	}

	/**
	 * Expand combo items back to individual products for order storage
	 * @param {Array} items - Items that may contain combo information
	 * @returns {Array} Individual product items
	 */
	static expandComboItems(items) {
		if (!items || items.length === 0) {
			return [];
		}

		const expandedItems = [];

		for (const item of items) {
			// If item has combo information, it's already expanded
			// Just pass through individual items
			if (item.productId) {
				expandedItems.push({
					productId: item.productId,
					quantity: item.quantity
				});
			}
		}

		return expandedItems;
	}

	/**
	 * Format currency helper
	 * @param {number} amount 
	 * @returns {string}
	 */
	static formatCurrency(amount) {
		return new Intl.NumberFormat('vi-VN', {
			style: 'currency',
			currency: 'VND'
		}).format(amount);
	}
}

module.exports = ComboService;
