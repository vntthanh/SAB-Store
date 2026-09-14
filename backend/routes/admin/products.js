const express = require('express');
const Product = require('../../models/Product');
const { asString, asEnum, asPageLimit, safeSearch } = require('../../utils/query-guard');
const { StockError, adjustStock } = require('../../services/stock');
const router = express.Router();

/** `stockQuantity` must be a non-negative integer; anything else is rejected outright. */
const isValidStockQuantity = (v) => Number.isInteger(v) && v >= 0;

/**
 * @route   GET /api/admin/products
 * @desc    Get all products for admin management
 * @access  Private (Admin authentication handled by parent router)
 */
router.get('/', async (req, res) => {
	try {
		const { page, limit, search, category, status } = req.query;
		const searchMatch = safeSearch(search);
		const safeCategory = asString(category, 100);
		// `status` used to compare against the *string* 'true': anything else —
		// including the UI's own 'all' — fell through to `false`, inverting the
		// filter. asEnum only accepts the two real values and drops the rest.
		const availableFilter = asEnum(status, ['true', 'false']);

		const filter = {
			...(searchMatch && { $or: [{ name: searchMatch }, { description: searchMatch }] }),
			...(safeCategory && safeCategory !== 'all' && { category: safeCategory }),
			...(availableFilter !== undefined && { available: availableFilter === 'true' })
		};

		const { page: safePage, limit: safeLimit } = asPageLimit(page, limit);
		const options = {
			page: safePage,
			limit: safeLimit,
			sort: { createdAt: -1 }
		};

		const products = await Product.paginate(filter, options);

		res.json({
			success: true,
			data: {
				products: products.docs,
				pagination: {
					page: products.page,
					pages: products.totalPages,
					total: products.totalDocs,
					limit: products.limit
				}
			}
		});
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
router.post('/', async (req, res) => {
	try {
		// stockQuantity IS accepted here (unlike PUT below): nothing can race a
		// product that does not exist yet, so a plain absolute write is safe —
		// there is no concurrent editor to compose with.
		const {
			name,
			description,
			price,
			category,
			imageUrl,
			available,
			isActive,
			minOrderQuantity,
			stockQuantity
		} = req.body;

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

		const product = new Product({
			name,
			description,
			price,
			category,
			imageUrl: imageUrl || undefined, // Let the schema default handle it
			available: available !== undefined ? available : true,
			isActive: isActive !== undefined ? isActive : true,
			stockQuantity: stockQuantity !== undefined ? stockQuantity : 0,
			minOrderQuantity: minOrderQuantity || 1
		});

		await product.save();

		res.status(201).json({
			success: true,
			message: 'Tạo sản phẩm thành công',
			data: { product }
		});
	} catch (error) {
		console.error('Create product error:', error);

		// Handle validation errors
		if (error.name === 'ValidationError') {
			const errorMessages = Object.values(error.errors).map(err => err.message);
			return res.status(400).json({
				success: false,
				message: errorMessages.join(', ')
			});
		}

		// Handle duplicate key errors
		if (error.code === 11000) {
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
});

/**
 * @route   PUT /api/admin/products/:id
 * @desc    Update product
 * @access  Private (Admin)
 */
router.put('/:id', async (req, res) => {
	try {
		const { id } = req.params;

		// Explicit allow-list, not `{...req.body}`: mongoose `strict` drops
		// unknown paths but every *real* schema path — including `sku`
		// (unique; setting it to another product's value would 11000-block that
		// product's own future update) and `createdAt` — was still writable.
		// `stockQuantity` is handled separately below: it is never written as
		// an absolute value here, only as a guarded delta (see below), so two
		// concurrent edits compose instead of last-write-wins.
		const { name, description, price, category, imageUrl, available, isActive, minOrderQuantity, stockQuantity } = req.body;

		if (stockQuantity !== undefined && !isValidStockQuantity(stockQuantity)) {
			return res.status(400).json({
				success: false,
				message: 'Số lượng tồn kho không hợp lệ'
			});
		}

		const existing = await Product.findById(id);
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
			...(isActive !== undefined && { isActive }),
			...(minOrderQuantity !== undefined && { minOrderQuantity })
		};

		let product = existing;
		if (Object.keys(updateData).length > 0) {
			product = await Product.findByIdAndUpdate(
				id,
				updateData,
				{ new: true, runValidators: true }
			);
		}

		// stockQuantity: the delta is computed from the value this admin's
		// request actually observed (`existing`, read above, before any other
		// field was touched), then applied as a guarded atomic $inc. Two
		// admins concurrently reading stock=50 and both submitting 60 each
		// compute delta=+10 independently and both apply it — the result is
		// 70 (composed), never a last-write-wins 60. A negative delta can
		// never push stock below 0 (see services/stock.js#adjustStock).
		if (stockQuantity !== undefined) {
			const delta = stockQuantity - existing.stockQuantity;
			if (delta !== 0) {
				try {
					product = await adjustStock(id, delta);
				} catch (stockErr) {
					if (stockErr instanceof StockError && stockErr.code === 'INSUFFICIENT_STOCK') {
						return res.status(400).json({
							success: false,
							message: 'Không thể giảm tồn kho xuống dưới 0',
							details: stockErr.details
						});
					}
					throw stockErr;
				}
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
		if (error.name === 'ValidationError') {
			const errorMessages = Object.values(error.errors).map(err => err.message);
			return res.status(400).json({
				success: false,
				message: errorMessages.join(', ')
			});
		}

		// Handle cast errors (invalid ID)
		if (error.name === 'CastError') {
			return res.status(400).json({
				success: false,
				message: 'ID sản phẩm không hợp lệ'
			});
		}

		// Handle duplicate key errors
		if (error.code === 11000) {
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
});

/**
 * @route   DELETE /api/admin/products/:id
 * @desc    Delete product
 * @access  Private (Admin)
 */
router.delete('/:id', async (req, res) => {
	try {
		const { id } = req.params;

		const product = await Product.findById(id);

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

		await Product.findByIdAndDelete(id);

		res.json({
			success: true,
			message: 'Xóa sản phẩm thành công'
		});
	} catch (error) {
		console.error('Delete product error:', error);

		// Handle cast errors (invalid ID)
		if (error.name === 'CastError') {
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
});

module.exports = router;
