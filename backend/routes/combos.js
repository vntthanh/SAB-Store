const express = require('express');
const Combo = require('../models/Combo');
const Product = require('../models/Product');
const ComboService = require('../services/ComboService');
const { authenticateAdmin, authenticateSeller, authenticateUser } = require('../middleware/better-auth');
const { validateComboItems } = require('../middleware/validation');
const ErrorLogger = require('../utils/errorLogger');
const router = express.Router();

/**
 * @route   GET /api/combos
 * @desc    Get all combos (admin only)
 * @access  Private/Admin
 */
router.get('/', authenticateAdmin, async (req, res) => {
	try {
		const { active } = req.query;

		let query = {};
		if (active === 'true') {
			query.isActive = true;
		} else if (active === 'false') {
			query.isActive = false;
		}

		const combos = await Combo.find(query)
			.sort({ priority: -1, createdAt: -1 })
			.lean();

		res.json({
			success: true,
			data: { combos }
		});
	} catch (error) {
		ErrorLogger.logRoute('GET /combos', error, req);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy danh sách combo'
		});
	}
});

/**
 * @route   GET /api/combos/active
 * @desc    Get active combos for combo detection
 * @access  Public
 */
router.get('/active', async (req, res) => {
	try {
		const combos = await Combo.findActive();

		res.json({
			success: true,
			data: { combos }
		});
	} catch (error) {
		ErrorLogger.logRoute('GET /combos/active', error, req);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy danh sách combo'
		});
	}
});

/**
 * @route   POST /api/combos/detect
 * @desc    Detect optimal combo combination for given products
 * @access  Public
 */
router.post('/detect', validateComboItems, async (req, res) => {
	try {
		const { items } = req.body;

		// Get product details for all items
		const productIds = items.map(item => item.productId);
		const products = await Product.find({ _id: { $in: productIds } });

		// Create products with quantities
		const productsWithQuantities = items.map(item => {
			const product = products.find(p => p._id.toString() === item.productId);
			return {
				product,
				quantity: item.quantity
			};
		}).filter(item => item.product); // Remove items where product not found

		if (productsWithQuantities.length === 0) {
			return res.json({
				success: true,
				data: {
					applicableCombos: [],
					bestCombo: null,
					optimalPricing: null
				}
			});
		}

		// Find optimal combo combination
		const optimalCombos = await Combo.findOptimalCombination(productsWithQuantities);

		// Calculate optimal pricing breakdown
		let optimalPricing = null;
		if (optimalCombos.length > 0) {
			const bestCombo = optimalCombos[0];

			// Calculate remaining items after applying best combo
			const remainingItems = [...productsWithQuantities];
			const productsByCategory = {};

			remainingItems.forEach(item => {
				if (!productsByCategory[item.product.category]) {
					productsByCategory[item.product.category] = [];
				}
				productsByCategory[item.product.category].push(item);
			});

			// Remove items used in combo
			let comboItemsUsed = [];
			for (const requirement of bestCombo.combo.categoryRequirements) {
				const categoryItems = productsByCategory[requirement.category] || [];
				let remainingNeeded = requirement.quantity * bestCombo.maxApplications;

				// Sort by price (highest first) to use most expensive items in combo
				categoryItems.sort((a, b) => b.product.price - a.product.price);

				for (let i = 0; i < categoryItems.length && remainingNeeded > 0; i++) {
					const item = categoryItems[i];
					const useQuantity = Math.min(item.quantity, remainingNeeded);

					comboItemsUsed.push({
						productId: item.product._id,
						productName: item.product.name,
						category: item.product.category,
						price: item.product.price,
						quantity: useQuantity,
						subtotal: useQuantity * item.product.price
					});

					// Update remaining quantity
					item.quantity -= useQuantity;
					remainingNeeded -= useQuantity;
				}
			}

			// Calculate remaining items cost
			const remainingItemsCost = remainingItems.reduce((total, item) => {
				return total + (item.product.price * item.quantity);
			}, 0);

			const comboTotal = bestCombo.maxApplications * bestCombo.combo.price;
			const originalTotal = productsWithQuantities.reduce((total, item) => {
				return total + (item.product.price * item.quantity);
			}, 0);

			optimalPricing = {
				originalTotal,
				comboApplications: bestCombo.maxApplications,
				comboName: bestCombo.combo.name,
				comboPrice: bestCombo.combo.price,
				comboTotal,
				comboItemsUsed,
				remainingItemsCost,
				finalTotal: comboTotal + remainingItemsCost,
				totalSavings: originalTotal - (comboTotal + remainingItemsCost),
				remainingItems: remainingItems.filter(item => item.quantity > 0).map(item => ({
					productId: item.product._id,
					productName: item.product.name,
					price: item.product.price,
					quantity: item.quantity,
					subtotal: item.product.price * item.quantity
				}))
			};
		}

		// Format response for backward compatibility
		const bestCombo = optimalCombos.length > 0 ? {
			...optimalCombos[0].combo.toObject(),
			maxApplications: optimalCombos[0].maxApplications,
			totalSavings: optimalCombos[0].totalSavings,
			savingsPerApplication: optimalCombos[0].savingsPerApplication,
			isBetterDeal: optimalCombos[0].totalSavings > 0,
			// Legacy fields for compatibility
			savings: optimalCombos[0].totalSavings,
			price: optimalPricing ? optimalPricing.finalTotal : optimalCombos[0].combo.price
		} : null;

		res.json({
			success: true,
			data: {
				applicableCombos: optimalCombos.map(analysis => ({
					...analysis.combo.toObject(),
					maxApplications: analysis.maxApplications,
					totalSavings: analysis.totalSavings,
					savingsPerApplication: analysis.savingsPerApplication,
					isBetterDeal: analysis.totalSavings > 0
				})),
				bestCombo,
				optimalPricing
			}
		});
	} catch (error) {
		ErrorLogger.logRoute('POST /combos/detect', error, req);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi phát hiện combo'
		});
	}
});

/**
 * @route   POST /api/combos
 * @desc    Create new combo
 * @access  Private/Admin
 */
router.post('/', authenticateAdmin, async (req, res) => {
	try {
		const { name, description, price, categoryRequirements, priority } = req.body;

		// Validate required fields
		if (!name || !price || !categoryRequirements || !Array.isArray(categoryRequirements)) {
			return res.status(400).json({
				success: false,
				message: 'Tên, giá và yêu cầu danh mục là bắt buộc'
			});
		}

		// Validate categoryRequirements
		if (categoryRequirements.length === 0) {
			return res.status(400).json({
				success: false,
				message: 'Combo phải có ít nhất một yêu cầu danh mục'
			});
		}

		// Check if all categories exist in products
		const categories = categoryRequirements.map(req => req.category);
		const existingCategories = await Product.distinct('category');
		const invalidCategories = categories.filter(cat => !existingCategories.includes(cat));

		if (invalidCategories.length > 0) {
			return res.status(400).json({
				success: false,
				message: `Danh mục không tồn tại: ${invalidCategories.join(', ')}`
			});
		}

		const combo = new Combo({
			name,
			description,
			price,
			categoryRequirements,
			priority: priority || 0
		});

		await combo.save();

		res.status(201).json({
			success: true,
			data: { combo },
			message: 'Tạo combo thành công'
		});
	} catch (error) {
		ErrorLogger.logRoute('POST /combos', error, req);

		if (error.name === 'ValidationError') {
			const errors = Object.values(error.errors).map(err => err.message);
			return res.status(400).json({
				success: false,
				message: errors.join(', ')
			});
		}

		// e.g. { price: 'abc' } fails Number coercion at save time as a CastError,
		// not a ValidationError — left uncaught this fell through to a 500.
		if (error.name === 'CastError') {
			return res.status(400).json({
				success: false,
				message: `Dữ liệu không hợp lệ: ${error.path}`
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi tạo combo'
		});
	}
});

/**
 * @route   POST /api/combos/pricing
 * @desc    Calculate optimal pricing for cart items
 * @access  Public
 */
router.post('/pricing', validateComboItems, async (req, res) => {
	try {
		const { items } = req.body;

		const pricingBreakdown = await ComboService.getPricingBreakdown(items);

		res.json({
			success: true,
			data: pricingBreakdown
		});
	} catch (error) {
		ErrorLogger.logRoute('POST /combos/pricing', error, req);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi tính toán giá'
		});
	}
});

/**
 * @route   GET /api/combos/pricing
 * @desc    Return error for GET requests to pricing endpoint
 * @access  Public
 */
router.get('/pricing', async (req, res) => {
	return res.status(405).json({
		success: false,
		message: 'Phương thức GET không được hỗ trợ. Vui lòng sử dụng POST.'
	});
});

/**
 * @route   PUT /api/combos/:id
 * @desc    Update combo
 * @access  Private/Admin
 */
router.put('/:id', authenticateAdmin, async (req, res) => {
	try {
		const { id } = req.params;
		const { name, description, price, categoryRequirements, priority, isActive } = req.body;

		// Validate ObjectId format
		if (!id.match(/^[0-9a-fA-F]{24}$/)) {
			return res.status(400).json({
				success: false,
				message: 'ID combo không hợp lệ'
			});
		}

		const combo = await Combo.findById(id);
		if (!combo) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy combo'
			});
		}

		// Validate categoryRequirements if provided
		if (categoryRequirements) {
			if (!Array.isArray(categoryRequirements) || categoryRequirements.length === 0) {
				return res.status(400).json({
					success: false,
					message: 'Combo phải có ít nhất một yêu cầu danh mục'
				});
			}

			// Check if all categories exist
			const categories = categoryRequirements.map(req => req.category);
			const existingCategories = await Product.distinct('category');
			const invalidCategories = categories.filter(cat => !existingCategories.includes(cat));

			if (invalidCategories.length > 0) {
				return res.status(400).json({
					success: false,
					message: `Danh mục không tồn tại: ${invalidCategories.join(', ')}`
				});
			}
		}

		// Update fields
		if (name !== undefined) combo.name = name;
		if (description !== undefined) combo.description = description;
		if (price !== undefined) combo.price = price;
		if (categoryRequirements !== undefined) combo.categoryRequirements = categoryRequirements;
		if (priority !== undefined) combo.priority = priority;
		if (isActive !== undefined) combo.isActive = isActive;

		await combo.save();

		res.json({
			success: true,
			data: { combo },
			message: 'Cập nhật combo thành công'
		});
	} catch (error) {
		ErrorLogger.logRoute('PUT /combos/:id', error, req);

		if (error.name === 'ValidationError') {
			const errors = Object.values(error.errors).map(err => err.message);
			return res.status(400).json({
				success: false,
				message: errors.join(', ')
			});
		}

		// e.g. { price: 'abc' } fails Number coercion at save time as a CastError,
		// not a ValidationError — left uncaught this fell through to a 500.
		if (error.name === 'CastError') {
			return res.status(400).json({
				success: false,
				message: `Dữ liệu không hợp lệ: ${error.path}`
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi cập nhật combo'
		});
	}
});

/**
 * @route   DELETE /api/combos/:id
 * @desc    Delete combo
 * @access  Private/Admin
 */
router.delete('/:id', authenticateAdmin, async (req, res) => {
	try {
		const { id } = req.params;

		// Validate ObjectId format
		if (!id.match(/^[0-9a-fA-F]{24}$/)) {
			return res.status(400).json({
				success: false,
				message: 'ID combo không hợp lệ'
			});
		}

		const combo = await Combo.findById(id);
		if (!combo) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy combo'
			});
		}

		await Combo.findByIdAndDelete(id);

		res.json({
			success: true,
			message: 'Xóa combo thành công'
		});
	} catch (error) {
		ErrorLogger.logRoute('DELETE /combos/:id', error, req);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi xóa combo'
		});
	}
});

/**
 * @route   GET /api/combos/:id
 * @desc    Get combo by ID
 * @access  Private/Admin
 */
router.get('/:id', authenticateAdmin, async (req, res) => {
	try {
		const { id } = req.params;

		// Validate ObjectId format
		if (!id.match(/^[0-9a-fA-F]{24}$/)) {
			return res.status(400).json({
				success: false,
				message: 'ID combo không hợp lệ'
			});
		}

		const combo = await Combo.findById(id);
		if (!combo) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy combo'
			});
		}

		res.json({
			success: true,
			data: { combo }
		});
	} catch (error) {
		ErrorLogger.logRoute('GET /combos/:id', error, req);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thông tin combo'
		});
	}
});

module.exports = router;
