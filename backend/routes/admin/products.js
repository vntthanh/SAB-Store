const express = require('express');
const mongoose = require('mongoose');
const Product = require('../../models/Product');
const { asString, asEnum, asPageLimit, safeSearch } = require('../../utils/query-guard');
const { recordAppliedOpening, countPendingByProduct } = require('../../services/stock-ledger');
const router = express.Router();

/** `stockQuantity` must be a non-negative integer; anything else is rejected outright. */
const isValidStockQuantity = (v) => Number.isInteger(v) && v >= 0;

const isValidSalesChannel = (v) => v === undefined || Product.SALES_CHANNELS.includes(v);
const INVALID_SALES_CHANNEL_MESSAGE = 'Kênh bán không hợp lệ';

/**
 * @route   GET /api/admin/products
 * @desc    Get all products for admin management
 * @access  Private (Admin authentication handled by parent router)
 */
router.get('/', async (req, res) => {
	try {
		const { page, limit, search, category, status, channel } = req.query;
		const searchMatch = safeSearch(search);
		const safeCategory = asString(category, 100);
		// `status` used to compare against the *string* 'true': anything else —
		// including the UI's own 'all' — fell through to `false`, inverting the
		// filter. asEnum only accepts the two real values and drops the rest.
		const availableFilter = asEnum(status, ['true', 'false']);

		// Filters on the channel the admin *set*, not on sellability. Documents
		// written before the field existed count as 'all'.
		const channelFilter = asEnum(channel, Product.SALES_CHANNELS);
		const channelClause = channelFilter === 'all'
			? { $or: [{ salesChannel: 'all' }, { salesChannel: { $exists: false } }] }
			: { salesChannel: channelFilter };

		// $and keeps the channel clause from colliding with the search $or.
		const clauses = [
			searchMatch && { $or: [{ name: searchMatch }, { description: searchMatch }] },
			channelFilter && channelClause
		].filter(Boolean);

		const filter = {
			...(clauses.length > 0 && { $and: clauses }),
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

		// Stock changes apply asynchronously; the count lets the UI flag a stock
		// figure that is about to change.
		const pending = await countPendingByProduct(products.docs.map((p) => p._id));
		const docs = products.docs.map((p) => ({ ...p.toJSON(), pendingMovements: pending.get(String(p._id)) || 0 }));

		res.json({
			success: true,
			data: {
				products: docs,
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
			stockQuantity
		} = req.body;

		if (!isValidSalesChannel(salesChannel)) {
			return res.status(400).json({ success: false, message: INVALID_SALES_CHANNEL_MESSAGE });
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
		// callback because withTransaction may run it again.
		let product;
		const session = await mongoose.startSession();
		try {
			await session.withTransaction(async () => {
				product = new Product({
					name,
					description,
					price,
					category,
					imageUrl: imageUrl || undefined, // Let the schema default handle it
					available: available !== undefined ? available : true,
					...(salesChannel !== undefined && { salesChannel }),
					stockQuantity: openingStock,
					minOrderQuantity: minOrderQuantity || 1
				});
				await product.save({ session });
				if (openingStock > 0) {
					await recordAppliedOpening(
						{ productId: product._id, quantity: openingStock, createdBy: req.user && req.user.email },
						{ session }
					);
				}
			});
		} finally {
			await session.endSession();
		}

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
		// `stockQuantity` is deliberately absent: it is a cache of the stock
		// ledger and changes only through POST /:id/stock-adjustments.
		const { name, description, price, category, imageUrl, available, salesChannel, minOrderQuantity } = req.body;

		if (!isValidSalesChannel(salesChannel)) {
			return res.status(400).json({ success: false, message: INVALID_SALES_CHANNEL_MESSAGE });
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
			...(salesChannel !== undefined && { salesChannel }),
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
