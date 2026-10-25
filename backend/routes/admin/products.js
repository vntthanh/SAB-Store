const express = require('express');
const { products: productRepo, storefronts: storefrontRepo } = require('../../data');
const { productStorefrontLink } = require('@sab/shared');
const { ERROR_CODES } = require('../../constants/errorCodes');
const { readStorefrontFilter, invalidStorefrontFilter, sendCoded } = require('./storefront-params');
const { validateBody } = require('../../middleware/validation');
const { RecordValidationError, DuplicateKeyError, InvalidIdError } = require('../../data/errors');
const { asString, asEnum, asPageLimit } = require('../../utils/query-guard');
const { recordAppliedOpening, countPendingByProduct } = require('../../services/stock-ledger');
const { withTransaction } = require('../../utils/transaction');
const { gated } = require('../../services/write-gate');
const { withPublicCodeRetry } = require('../../utils/public-code');
const router = express.Router();

/** `stockQuantity` must be a non-negative integer; anything else is rejected outright. */
const isValidStockQuantity = (v) => Number.isInteger(v) && v >= 0;

const isValidSalesChannel = (v) => v === undefined || productRepo.SALES_CHANNELS.includes(v);
const INVALID_SALES_CHANNEL_MESSAGE = 'Kênh bán không hợp lệ';

/**
 * @route   GET /api/admin/products
 * @desc    One page of products for admin management: `{ success, data, meta }`
 * @access  Private (Admin authentication handled by parent router)
 */
router.get('/', async (req, res) => {
	try {
		const { page, limit, search, category, status, channel } = req.query;
		const storefront = readStorefrontFilter(req.query.storefrontId);
		if (storefront.invalid) return invalidStorefrontFilter(res);
		const safeCategory = asString(category, 100);
		// `status` used to compare against the *string* 'true': anything else —
		// including the UI's own 'all' — fell through to `false`, inverting the
		// filter. asEnum only accepts the two real values and drops the rest.
		const availableFilter = asEnum(status, ['true', 'false']);
		const { page: safePage, limit: safeLimit } = asPageLimit(page, limit);

		const { data: rows, meta } = await productRepo.listPage({
			page: safePage,
			limit: safeLimit,
			search: asString(search, 100),
			category: safeCategory && safeCategory !== 'all' ? safeCategory : undefined,
			available: availableFilter === undefined ? undefined : availableFilter === 'true',
			salesChannel: asEnum(channel, productRepo.SALES_CHANNELS),
			storefrontId: storefront.value
		});

		// Stock changes apply asynchronously; the count lets the UI flag a stock
		// figure that is about to change.
		const pending = await countPendingByProduct(rows.map((p) => p._id));
		const data = rows.map((p) => ({ ...p, pendingMovements: pending.get(String(p._id)) || 0 }));

		res.json({ success: true, data, meta });
	} catch (error) {
		console.error('Get products error:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy danh sách sản phẩm'
		});
	}
});

/**
 * @route   POST /api/admin/products
 * @desc    Create new product
 * @access  Private (Admin)
 */
router.post('/', validateBody(productStorefrontLink), gated(async (req, res) => {
	try {
		// stockQuantity is only the opening balance of a product that did not exist
		// until now; it is recorded as an `opening` movement below. Every later
		// change goes through POST /:id/stock-adjustments.
		const {
			name,
			description,
			price,
			category,
			imageUrl,
			available,
			salesChannel,
			minOrderQuantity,
			stockQuantity,
			storefrontId
		} = req.body;

		if (!isValidSalesChannel(salesChannel)) {
			return res.status(400).json({ success: false, message: INVALID_SALES_CHANNEL_MESSAGE });
		}

		if (storefrontId !== undefined && !(await storefrontRepo.findById(storefrontId))) {
			return sendCoded(res, ERROR_CODES.STOREFRONT_NOT_FOUND);
		}

		// Validate required fields
		if (!name || !price || !category) {
			return res.status(400).json({
				success: false,
				message: 'Tên, giá và danh mục sản phẩm là bắt buộc'
			});
		}

		if (stockQuantity !== undefined && !isValidStockQuantity(stockQuantity)) {
			return res.status(400).json({
				success: false,
				message: 'Số lượng tồn kho không hợp lệ'
			});
		}

		const openingStock = stockQuantity !== undefined ? stockQuantity : 0;

		// The product and its opening movement commit together, so the cache and
		// the ledger agree from the first moment. The document is built inside the
		// callback because withTransaction may run it again. A publicCode collision
		// aborts the whole transaction, so the retry wraps it and draws a new code.
		const product = await withPublicCodeRetry(() => withTransaction(async (session) => {
			const created = await productRepo.create({
				name,
				description,
				price,
				category,
				imageUrl: imageUrl || undefined, // Let the schema default handle it
				available: available !== undefined ? available : true,
				...(salesChannel !== undefined && { salesChannel }),
				...(storefrontId !== undefined && { storefrontId }),
				minOrderQuantity: minOrderQuantity || 1
			}, openingStock, session);
			if (openingStock > 0) {
				await recordAppliedOpening(
					{ productId: created._id, quantity: openingStock, createdBy: req.user && req.user.email },
					{ session }
				);
			}
			return created;
		}));

		res.status(201).json({
			success: true,
			message: 'Tạo sản phẩm thành công',
			data: { product }
		});
	} catch (error) {
		console.error('Create product error:', error);

		// Handle validation errors
		if (error instanceof RecordValidationError) {
			return res.status(400).json({
				success: false,
				message: error.fieldErrors.map(entry => entry.message).join(', ')
			});
		}

		// Handle duplicate key errors
		if (error instanceof DuplicateKeyError) {
			return res.status(400).json({
				success: false,
				message: 'Sản phẩm với thông tin này đã tồn tại'
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi tạo sản phẩm'
		});
	}
}));

/**
 * @route   PUT /api/admin/products/:id
 * @desc    Update product
 * @access  Private (Admin)
 */
router.put('/:id', validateBody(productStorefrontLink), gated(async (req, res) => {
	try {
		const { id } = req.params;

		// Explicit allow-list, not `{...req.body}`: mongoose `strict` drops
		// unknown paths but every *real* schema path — including `sku`
		// (unique; setting it to another product's value would 11000-block that
		// product's own future update) and `createdAt` — was still writable.
		// `stockQuantity` is deliberately absent: it is a cache of the stock
		// ledger and changes only through POST /:id/stock-adjustments.
		const { name, description, price, category, imageUrl, available, salesChannel, minOrderQuantity, storefrontId } = req.body;

		if (!isValidSalesChannel(salesChannel)) {
			return res.status(400).json({ success: false, message: INVALID_SALES_CHANNEL_MESSAGE });
		}

		if (storefrontId !== undefined && !(await storefrontRepo.findById(storefrontId))) {
			return sendCoded(res, ERROR_CODES.STOREFRONT_NOT_FOUND);
		}

		const existing = await productRepo.findById(id);
		if (!existing) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy sản phẩm'
			});
		}

		const updateData = {
			...(name !== undefined && { name }),
			...(description !== undefined && { description }),
			...(price !== undefined && { price }),
			...(category !== undefined && { category }),
			...(imageUrl && { imageUrl }), // empty string: let existing value remain
			...(available !== undefined && { available }),
			...(salesChannel !== undefined && { salesChannel }),
			...(minOrderQuantity !== undefined && { minOrderQuantity }),
			...(storefrontId !== undefined && { storefrontId })
		};

		let product = existing;

		if (Object.keys(updateData).length > 0) {
			product = await productRepo.update(id, updateData);
			// Deleted between the lookup above and the update.
			if (!product) {
				return res.status(404).json({
					success: false,
					message: 'Không tìm thấy sản phẩm'
				});
			}
		}

		res.json({
			success: true,
			message: 'Cập nhật sản phẩm thành công',
			data: { product }
		});
	} catch (error) {
		console.error('Update product error:', error);

		// Handle validation errors
		if (error instanceof RecordValidationError) {
			return res.status(400).json({
				success: false,
				message: error.fieldErrors.map(entry => entry.message).join(', ')
			});
		}

		// Handle cast errors (invalid ID)
		if (error instanceof InvalidIdError) {
			return res.status(400).json({
				success: false,
				message: 'ID sản phẩm không hợp lệ'
			});
		}

		// Handle duplicate key errors
		if (error instanceof DuplicateKeyError) {
			return res.status(400).json({
				success: false,
				message: 'Sản phẩm với thông tin này đã tồn tại'
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi cập nhật sản phẩm'
		});
	}
}));

/**
 * @route   DELETE /api/admin/products/:id
 * @desc    Delete product
 * @access  Private (Admin)
 */
router.delete('/:id', gated(async (req, res) => {
	try {
		const { id } = req.params;

		const product = await productRepo.findById(id);

		if (!product) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy sản phẩm'
			});
		}

		if (product.imageUrl && product.imageUrl !== '/fallback-product.png' && product.imageUrl.startsWith('/uploads/')) {
			try {
				const objectName = product.imageUrl.replace('/uploads/', '');
				const { deleteFile } = require('../../lib/minio');
				await deleteFile(objectName);
				console.log(`[DELETE PRODUCT] Deleted image: ${objectName}`);
			} catch (imageError) {
				console.error('[DELETE PRODUCT] Error deleting image:', imageError);
			}
		}

		await productRepo.remove(id);

		res.json({
			success: true,
			message: 'Xóa sản phẩm thành công'
		});
	} catch (error) {
		console.error('Delete product error:', error);

		// Handle cast errors (invalid ID)
		if (error instanceof InvalidIdError) {
			return res.status(400).json({
				success: false,
				message: 'ID sản phẩm không hợp lệ'
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi xóa sản phẩm'
		});
	}
}));

module.exports = router;
