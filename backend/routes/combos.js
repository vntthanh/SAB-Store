const express = require('express');
const Combo = require('../models/Combo');
const Product = require('../models/Product');
const { authenticateAdmin, authenticateSeller, authenticateUser } = require('../middleware/better-auth');
const { validateComboItems } = require('../middleware/validation');
const { computeOrderPricing, pricingErrorBody, PricingError } = require('../services/pricing');
const { asEnum } = require('../utils/query-guard');
const { createWithPublicCodeRetry } = require('../utils/public-code');
const ErrorLogger = require('../utils/errorLogger');
const { ErrorResponse } = require('../utils/errorResponse');
const { findPublicComboByCode } = require('../services/public-catalog');
const router = express.Router();

const SALE_CHANNELS = ['online', 'offline'];
const INVALID_SALES_CHANNEL_MESSAGE = 'Kênh bán không hợp lệ';

// An unknown channel falls back to online (the storefront) instead of erroring:
// these are read-only previews, and the order routes enforce the channel anyway.
const channelOf = (value) => asEnum(value, SALE_CHANNELS) || 'online';

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
		const combos = await Combo.findSellable(channelOf(req.query.channel));

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
 * @route   GET /api/combos/by-code/:code
 * @desc    Get a combo sold online by its public code
 * @access  Public
 */
router.get('/by-code/:code', async (req, res) => {
	try {
		const combo = await findPublicComboByCode(req.params.code);
		if (!combo) {
			return res
				.status(404)
				.json(ErrorResponse.formatErrorResponse(ErrorResponse.notFoundError('Combo'), req));
		}

		res.set('Cache-Control', 'public, max-age=60');
		res.json({ success: true, data: combo });
	} catch (error) {
		ErrorLogger.logRoute('GET /combos/by-code/:code', error, req);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thông tin combo'
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
		const { name, description, price, categoryRequirements, priority, salesChannel } = req.body;

		if (salesChannel !== undefined && !asEnum(salesChannel, Product.SALES_CHANNELS)) {
			return res.status(400).json({ success: false, message: INVALID_SALES_CHANNEL_MESSAGE });
		}

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

		const combo = await createWithPublicCodeRetry(Combo, {
			name,
			description,
			price,
			categoryRequirements,
			priority: priority || 0,
			...(salesChannel !== undefined && { salesChannel })
		});

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
 * @desc    Preview the price of a cart. Same engine as order creation, so the
 *          total returned here is the total an order with these items is
 *          charged (clients echo it back as `expectedTotal`).
 * @access  Public
 */
router.post('/pricing', validateComboItems, async (req, res) => {
	try {
		const { items } = req.body;

		const { originalTotal, totalAmount, savings, orderItems, comboInfo } =
			await computeOrderPricing(items, { channel: channelOf(req.body.channel) });

		res.json({
			success: true,
			data: {
				originalTotal,
				totalAmount,
				savings,
				orderItems: orderItems.map((item) => ({
					...item,
					productId: item.productId.toString(),
					comboId: item.comboId ? item.comboId.toString() : null
				})),
				comboInfo,
				// Kept so seller tabs opened before a deploy keep rendering: that
				// bundle reads `summary.totalSavings`. Remove after the next release.
				summary: { originalTotal, totalSavings: savings, finalTotal: totalAmount }
			}
		});
	} catch (error) {
		if (error instanceof PricingError) {
			return res.status(error.httpStatus).json(pricingErrorBody(error));
		}
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
		const { name, description, price, categoryRequirements, priority, isActive, salesChannel } = req.body;

		if (salesChannel !== undefined && !asEnum(salesChannel, Product.SALES_CHANNELS)) {
			return res.status(400).json({ success: false, message: INVALID_SALES_CHANNEL_MESSAGE });
		}

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
		if (salesChannel !== undefined) combo.salesChannel = salesChannel;

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
