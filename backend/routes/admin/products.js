const express = require('express');
const Product = require('../../models/Product');
const { asString, asEnum, asPageLimit, safeSearch } = require('../../utils/query-guard');
const router = express.Router();

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
		// stockQuantity intentionally not destructured: it is Phase 06's atomic
		// stock path's field alone. Accepting it here would let an absolute
		// admin write race the guarded increment/decrement path.
		const {
			name,
			description,
			price,
			category,
			imageUrl,
			available,
			isActive,
			minOrderQuantity
		} = req.body;

		// Validate required fields
		if (!name || !price || !category) {
			return res.status(400).json({
				success: false,
				message: 'Tên, giá và danh mục sản phẩm là bắt buộc'
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
			stockQuantity: 0,
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
		// unknown paths but every *real* schema path — including `stockQuantity`
		// (Phase 06's atomic stock path owns absolute writes to it), `sku`
		// (unique; setting it to another product's value would 11000-block that
		// product's own future update) and `createdAt` — was still writable.
		const { name, description, price, category, imageUrl, available, isActive, minOrderQuantity } = req.body;
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

		const product = await Product.findByIdAndUpdate(
			id,
			updateData,
			{ new: true, runValidators: true }
		);

		if (!product) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy sản phẩm'
			});
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
