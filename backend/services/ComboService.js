const mongoose = require('mongoose');
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

		// Merge duplicate productId lines and normalize ObjectId casing —
		// mirrors services/pricing.js:96-107.
		//
		// F3: without merging, two cart lines for the same product each keep
		// their own entry in `remainingProducts`. applyComboToProducts()
		// consumes combo quantity via `remainingProducts.find(p =>
		// p.productId === item.productId)`, which always returns the FIRST
		// matching entry — so the second line's consumption is subtracted
		// from the first line while the second line's full quantity survives
		// untouched. A 2-unit duplicate-line cart (two lines of 1 each) that
		// qualifies for a combo needing 2 then bills combo(2) + individual(1)
		// and deducts 3 units of stock for a 2-unit purchase.
		//
		// F4: an uppercase-hex productId passes Product.find's `$in` (Mongo
		// casts case-insensitively) but fails the strict `p._id.toString() ===
		// item.productId` compare below, silently dropping the line.
		// Normalizing every id through `new ObjectId(...).toString()` here
		// (lowercase, canonical form) fixes both the merge key and the
		// compare the same way.
		const qtyByProductId = new Map();
		for (const item of items) {
			const rawId = item && item.productId;
			if (!rawId || !mongoose.Types.ObjectId.isValid(rawId)) continue;
			const key = new mongoose.Types.ObjectId(rawId).toString();
			const quantity = Number(item.quantity) || 0;
			if (quantity <= 0) continue;
			qtyByProductId.set(key, (qtyByProductId.get(key) || 0) + quantity);
		}

		const mergedItems = [...qtyByProductId.entries()].map(([productId, quantity]) => ({ productId, quantity }));

		if (mergedItems.length === 0) {
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
		const productIds = mergedItems.map(item => item.productId);
		const products = await Product.find({ _id: { $in: productIds } });

		// Create products with quantities
		let remainingProducts = mergedItems.map(item => {
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

		// F3 defense-in-depth: the per-application post-condition inside
		// applyComboToProducts (e.g. "2 items consumed for 2 needed") cannot
		// catch the duplicate-line bug above, because it only checks the
		// count *within one combo application* — 2 consumed for a combo
		// needing 2 is correct in isolation even when the wrong entry was
		// decremented. This checks the whole cart instead, after every combo
		// has been applied below: total quantity consumed across every combo
		// application plus every remaining individual item must equal the
		// merged input quantity, or stock/money for this cart would silently
		// not match what was actually charged/deducted.
		const totalInputQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);

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

		// F3 defense-in-depth post-condition (see comment above): every unit
		// bought must be accounted for exactly once, either inside a combo
		// application or as a remaining individual line.
		const comboConsumedQuantity = appliedCombos.reduce(
			(sum, applied) => sum + applied.itemsUsed.reduce((s, i) => s + i.quantity, 0),
			0
		);
		const remainingQuantity = remainingProducts.reduce((sum, item) => sum + item.quantity, 0);
		if (comboConsumedQuantity + remainingQuantity !== totalInputQuantity) {
			throw new Error(
				`Kiểm tra số lượng thất bại: giỏ hàng có ${totalInputQuantity} sản phẩm nhưng đã xử lý ${comboConsumedQuantity + remainingQuantity}`
			);
		}

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
