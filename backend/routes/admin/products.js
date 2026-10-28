const express = require('express');
const { products: productRepo, storefronts: storefrontRepo } = require('../../data');
const { productStorefrontLink, PRODUCT_UPLOAD_PATTERN, FALLBACK_PRODUCT_IMAGE } = require('@sab/shared');
const { ERROR_CODES } = require('../../constants/errorCodes');
const { readStorefrontFilter, invalidStorefrontFilter, sendCoded } = require('./storefront-params');
const { validateBody, validateProductSetup } = require('../../middleware/validation');
const { RecordValidationError, DuplicateKeyError, InvalidIdError } = require('../../data/errors');
const { asString, asEnum, asPageLimit } = require('../../utils/query-guard');
const { recordAppliedOpening, countPendingByProduct } = require('../../services/stock-ledger');
const { withTransaction } = require('../../utils/transaction');
const { gated } = require('../../services/write-gate');
const { withPublicCodeRetry } = require('../../utils/public-code');
const router = express.Router();

/** The product uploads a product shows: gallery, cover and variant images. Nothing else is ever deleted. */
function uploadsOf(product) {
	const urls = [product.imageUrl, ...(product.images || []), ...(product.variants || []).map((variant) => variant.imageUrl)];
	return new Set(urls.filter((url) => typeof url === 'string' && PRODUCT_UPLOAD_PATTERN.test(url)));
}

/**
 * Delete the uploaded objects among `urls` that no product or variant shows any
 * more. Runs after the database change committed; a storage failure is logged
 * and never fails the request (the object is then only an orphan).
 */
async function deleteUnusedUploads(urls) {
	// Read at call time, so a test can stub the storage call.
	const { deleteFile } = require('../../lib/minio');
	for (const url of urls) {
		try {
			if (await productRepo.isImageInUse(url)) continue;
			await deleteFile(url.replace('/uploads/', ''));
		} catch (error) {
			console.error('[PRODUCT IMAGES] Could not delete an unused image:', error.message);
		}
	}
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : value);
const trimmedList = (list) => (Array.isArray(list) ? list.map(trimmed) : list);

/** The gallery the body carries, trimmed as the shared schema checked it (validation does not rewrite the body). */
const imagesOf = (body) => trimmedList(body.images);

/**
 * The options and variants the body carries (they come together; the shared
 * schema enforces it), with every text trimmed as that schema checked it and
 * only the fields the repository reads.
 */
function setupOf(body) {
	if (body.options === undefined) return null;
	return {
		options: body.options.map((option) => ({
			name: trimmed(option.name),
			values: trimmedList(option.values),
			...(option.previousName !== undefined && { previousName: trimmed(option.previousName) }),
			...(option.previousValues !== undefined && { previousValues: trimmedList(option.previousValues) })
		})),
		variants: body.variants.map((variant) => ({
			optionValues: trimmedList(variant.optionValues),
			price: variant.price == null ? null : Number(variant.price),
			sku: trimmed(variant.sku) || null,
			imageUrl: trimmed(variant.imageUrl) || null,
			isActive: variant.isActive !== false,
			...(variant.openingStock !== undefined && { openingStock: Number(variant.openingStock) })
		}))
	};
}

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
router.post('/', validateBody(productStorefrontLink), validateProductSetup, gated(async (req, res) => {
	try {
		// stockQuantity is only the opening balance of a product that did not exist
		// until now; it is recorded as an `opening` movement below. Every later
		// change goes through POST /:id/stock-adjustments. With options and
		// variants, each variant's `openingStock` is its own opening balance.
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
		const images = imagesOf(req.body);
		const setup = setupOf(req.body);

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

		const openingStock = setup || stockQuantity === undefined ? 0 : stockQuantity;

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
				...(images !== undefined && { images }),
				available: available !== undefined ? available : true,
				...(salesChannel !== undefined && { salesChannel }),
				...(storefrontId !== undefined && { storefrontId }),
				minOrderQuantity: minOrderQuantity || 1
			}, openingStock, session);
			const createdBy = req.user && req.user.email;
			if (setup) {
				const { openings } = await productRepo.saveVariantSetup(created._id, setup, session, { creating: true });
				for (const { variantId, quantity } of openings) {
					await recordAppliedOpening({ productId: created._id, variantId, quantity, createdBy }, { session });
				}
				return productRepo.findById(created._id, session);
			}
			if (openingStock > 0) {
				await recordAppliedOpening({ productId: created._id, quantity: openingStock, createdBy }, { session });
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
				message: error.fields.includes('sku') ? 'SKU đã được dùng cho sản phẩm hoặc phân loại khác' : 'Sản phẩm với thông tin này đã tồn tại'
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
router.put('/:id', validateBody(productStorefrontLink), validateProductSetup, gated(async (req, res) => {
	try {
		const { id } = req.params;

		// Explicit allow-list, not `{...req.body}`: a store's `strict` mode drops
		// unknown paths but every *real* schema path — including `sku`
		// (unique; setting it to another product's value would block that
		// product's own future update) and `createdAt` — was still writable.
		// `stockQuantity` is deliberately absent: it is a cache of the stock
		// ledger and changes only through POST /:id/stock-adjustments.
		const { name, description, price, category, imageUrl, available, salesChannel, minOrderQuantity, storefrontId } = req.body;
		const images = imagesOf(req.body);
		const setup = setupOf(req.body);

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

		// The older single-image body (no `images`) resends the cover on every edit: an
		// unchanged one must leave the gallery alone; a new one replaces it.
		const nextImages = images !== undefined ? images
			: imageUrl && imageUrl !== existing.imageUrl ? (imageUrl === FALLBACK_PRODUCT_IMAGE ? [] : [imageUrl]) : undefined;
		const updateData = {
			...(name !== undefined && { name }),
			...(description !== undefined && { description }),
			...(price !== undefined && { price }),
			...(category !== undefined && { category }),
			...(nextImages !== undefined && { images: nextImages }),
			...(available !== undefined && { available }),
			...(salesChannel !== undefined && { salesChannel }),
			...(minOrderQuantity !== undefined && { minOrderQuantity }),
			...(storefrontId !== undefined && { storefrontId })
		};

		// A gallery change without a new variant setup must keep every image a variant shows.
		if (nextImages !== undefined && !setup && (existing.variants || []).some((variant) => variant.imageUrl && !nextImages.includes(variant.imageUrl))) {
			return res.status(400).json({ success: false, message: 'Ảnh đang được dùng cho một tổ hợp phân loại; đổi ảnh của tổ hợp trước' });
		}

		const product = await withTransaction(async (tx) => {
			// The variants are locked before the product row, in the stock ledger's order.
			if (setup) await productRepo.lockVariants(id, tx);
			const updated = Object.keys(updateData).length > 0 ? await productRepo.update(id, updateData, tx) : existing;
			if (!updated || !setup) return updated;
			await productRepo.saveVariantSetup(id, setup, tx);
			return productRepo.findById(id, tx);
		});
		// Deleted between the lookup above and the update.
		if (!product) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy sản phẩm'
			});
		}

		const kept = uploadsOf(product);
		await deleteUnusedUploads([...uploadsOf(existing)].filter((url) => !kept.has(url)));

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
				message: error.fields.includes('sku') ? 'SKU đã được dùng cho sản phẩm hoặc phân loại khác' : 'Sản phẩm với thông tin này đã tồn tại'
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

		await productRepo.remove(id);
		await deleteUnusedUploads(uploadsOf(product));

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
