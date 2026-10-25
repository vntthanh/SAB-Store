const express = require('express');
const { gated } = require('../services/write-gate');
const { combos: comboRepo, products: productRepo, storefronts: storefrontRepo } = require('../data');
const { RecordValidationError } = require('../data/errors');
const { isRecordId } = require('../data/ids');
const { authenticateAdmin, authenticateSeller, authenticateUser } = require('../middleware/better-auth');
const { validateBody, validateComboItems } = require('../middleware/validation');
const { computeOrderPricing, pricingErrorBody, PricingError } = require('../services/pricing');
const { asEnum, asString } = require('../utils/query-guard');
const { comboStorefrontLinks } = require('@sab/shared');
const { ERROR_CODES } = require('../constants/errorCodes');
const { sendCoded } = require('./admin/storefront-params');
const ErrorLogger = require('../utils/errorLogger');
const { ErrorResponse } = require('../utils/errorResponse');
const { findViewableComboByCode, onlyOpenCombos } = require('../services/public-catalog');
const { resolveViewer, isStaff, assertCanViewCart, StorefrontAccessError, sendAccessError } = require('../services/storefront-access');
const router = express.Router();

const SALE_CHANNELS = ['online', 'offline'];
const INVALID_SALES_CHANNEL_MESSAGE = 'Kênh bán không hợp lệ';

// An unknown channel falls back to online (the storefront) instead of erroring:
// these are read-only previews, and the order routes enforce the channel anyway.
const channelOf = (value) => asEnum(value, SALE_CHANNELS) || 'online';

/**
 * The storefront ids of a validated body, lowercased like the stored ones, or
 * `unknown` when one names no storefront. `ids: undefined` means the field was not
 * sent (create then defaults it, update keeps the links).
 */
async function linkedStorefronts(raw) {
	if (raw === undefined) return { ids: undefined };
	const ids = raw.map((id) => id.toLowerCase());
	const existing = new Set((await storefrontRepo.listAll()).map((storefront) => storefront._id));
	return ids.every((id) => existing.has(id)) ? { ids } : { unknown: true };
}

/**
 * @route   GET /api/combos
 * @desc    Get all combos (admin only)
 * @access  Private/Admin
 */
router.get('/', authenticateAdmin, async (req, res) => {
	try {
		const { active } = req.query;

		let isActive;
		if (active === 'true') {
			isActive = true;
		} else if (active === 'false') {
			isActive = false;
		}

		let combos = await comboRepo.list({ active: isActive });

		// "Linked to": a combo is offered in several storefronts.
		const storefrontId = asString(req.query.storefrontId, 64);
		if (storefrontId) {
			const wanted = storefrontId.toLowerCase();
			combos = combos.filter((combo) => (combo.storefrontIds || []).includes(wanted));
		}

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
		// A private storefront's combos come with its own catalog.
		const combos = await onlyOpenCombos(await comboRepo.listSellable(channelOf(req.query.channel)));

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
		const found = await findViewableComboByCode(req.params.code, await resolveViewer(req));
		if (!found) {
			return res
				.status(404)
				.json(ErrorResponse.formatErrorResponse(ErrorResponse.notFoundError('Combo'), req));
		}

		// A combo with a private storefront depends on who asks, so a shared cache must not keep it.
		res.set('Cache-Control', found.cacheable ? 'public, max-age=60' : 'private, no-store');
		res.json({ success: true, data: found.data });
	} catch (error) {
		if (error instanceof StorefrontAccessError) return sendAccessError(res, error);
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
router.post('/', authenticateAdmin, validateBody(comboStorefrontLinks), gated(async (req, res) => {
	try {
		const { name, description, price, categoryRequirements, priority, salesChannel } = req.body;

		if (salesChannel !== undefined && !asEnum(salesChannel, productRepo.SALES_CHANNELS)) {
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
		const existingCategories = await productRepo.listCategories();
		const invalidCategories = categories.filter(cat => !existingCategories.includes(cat));

		if (invalidCategories.length > 0) {
			return res.status(400).json({
				success: false,
				message: `Danh mục không tồn tại: ${invalidCategories.join(', ')}`
			});
		}

		const links = await linkedStorefronts(req.body.storefrontIds);
		if (links.unknown) return sendCoded(res, ERROR_CODES.STOREFRONT_NOT_FOUND);

		const combo = await comboRepo.create({
			name,
			description,
			price,
			categoryRequirements,
			priority: priority || 0,
			...(salesChannel !== undefined && { salesChannel }),
			...(links.ids && { storefrontIds: links.ids })
		});

		res.status(201).json({
			success: true,
			data: { combo },
			message: 'Tạo combo thành công'
		});
	} catch (error) {
		ErrorLogger.logRoute('POST /combos', error, req);

		if (error instanceof RecordValidationError) {
			return res.status(400).json({
				success: false,
				message: error.fieldErrors.map(entry => entry.message).join(', ')
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi tạo combo'
		});
	}
}));

/**
 * @route   POST /api/combos/pricing
 * @desc    Preview the price of a cart. Same engine as order creation, so the
 *          total returned here is the total an order with these items is
 *          charged (clients echo it back as `expectedTotal`).
 * @access  Public
 */
router.post('/pricing', validateComboItems, async (req, res) => {
	try {
		// Validation accepts digit-string quantities without rewriting them; the engine needs numbers.
		const items = req.body.items.map((item) => ({ ...item, quantity: Number(item.quantity) }));

		// Before pricing: its errors name products and prices, which a viewer
		// without access to the storefront must not learn.
		const viewer = await resolveViewer(req);
		await assertCanViewCart(items, viewer);

		// The scope the order route will use: a counter cart may span storefronts
		// only for the staff who ring it up (seller direct sale); any other cart is
		// one storefront's.
		const channel = channelOf(req.body.channel);
		const scope = channel === 'offline' && isStaff(viewer) ? 'any' : 'single';
		const { originalTotal, totalAmount, savings, orderItems, comboInfo } =
			await computeOrderPricing(items, { channel, scope });

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
		if (error instanceof StorefrontAccessError) return sendAccessError(res, error);
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
router.put('/:id', authenticateAdmin, validateBody(comboStorefrontLinks), gated(async (req, res) => {
	try {
		const { id } = req.params;
		const { name, description, price, categoryRequirements, priority, isActive, salesChannel } = req.body;

		if (salesChannel !== undefined && !asEnum(salesChannel, productRepo.SALES_CHANNELS)) {
			return res.status(400).json({ success: false, message: INVALID_SALES_CHANNEL_MESSAGE });
		}

		// The store's own id format (hex or uuid)
		if (!isRecordId(id)) {
			return res.status(400).json({
				success: false,
				message: 'ID combo không hợp lệ'
			});
		}

		const combo = await comboRepo.findById(id);
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
			const existingCategories = await productRepo.listCategories();
			const invalidCategories = categories.filter(cat => !existingCategories.includes(cat));

			if (invalidCategories.length > 0) {
				return res.status(400).json({
					success: false,
					message: `Danh mục không tồn tại: ${invalidCategories.join(', ')}`
				});
			}
		}

		const links = await linkedStorefronts(req.body.storefrontIds);
		if (links.unknown) return sendCoded(res, ERROR_CODES.STOREFRONT_NOT_FOUND);

		const updated = await comboRepo.update(id, {
			name, description, price, categoryRequirements, priority, isActive, salesChannel,
			storefrontIds: links.ids
		});
		// Deleted between the lookup above and the save.
		if (!updated) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy combo'
			});
		}

		res.json({
			success: true,
			data: { combo: updated },
			message: 'Cập nhật combo thành công'
		});
	} catch (error) {
		ErrorLogger.logRoute('PUT /combos/:id', error, req);

		if (error instanceof RecordValidationError) {
			return res.status(400).json({
				success: false,
				message: error.fieldErrors.map(entry => entry.message).join(', ')
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi cập nhật combo'
		});
	}
}));

/**
 * @route   DELETE /api/combos/:id
 * @desc    Delete combo
 * @access  Private/Admin
 */
router.delete('/:id', authenticateAdmin, gated(async (req, res) => {
	try {
		const { id } = req.params;

		// The store's own id format (hex or uuid)
		if (!isRecordId(id)) {
			return res.status(400).json({
				success: false,
				message: 'ID combo không hợp lệ'
			});
		}

		const combo = await comboRepo.findById(id);
		if (!combo) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy combo'
			});
		}

		await comboRepo.remove(id);

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
}));

/**
 * @route   GET /api/combos/:id
 * @desc    Get combo by ID
 * @access  Private/Admin
 */
router.get('/:id', authenticateAdmin, async (req, res) => {
	try {
		const { id } = req.params;

		// The store's own id format (hex or uuid)
		if (!isRecordId(id)) {
			return res.status(400).json({
				success: false,
				message: 'ID combo không hợp lệ'
			});
		}

		const combo = await comboRepo.findById(id);
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
