const express = require('express');
const Product = require('../models/Product');
const { asString, safeSearch } = require('../utils/query-guard');
const { authenticateSeller } = require('../middleware/better-auth');
const router = express.Router();

/**
 * @route   GET /api/products
 * @desc    Get all products
 * @access  Public
 */
router.get('/', async (req, res) => {
	try {
		const { category, search, available } = req.query;
		const safeCategory = category !== 'all' ? asString(category, 100) : undefined;
		const searchMatch = safeSearch(search);

		// The public storefront is the online channel; no query parameter
		// widens it (a stopped product must never be listed publicly).
		const filter = {
			...(safeCategory && { category: safeCategory }),
			...(searchMatch && { $or: [{ name: searchMatch }, { description: searchMatch }] })
		};

		// Get products with sorting
		const products = await Product.findSellable('online', filter)
			.sort({ category: 1, name: 1 })
			.lean();

		// Group products by category
		const categories = [...new Set(products.map(p => p.category))];
		const groupedProducts = categories.reduce((acc, category) => {
			acc[category] = products.filter(p => p.category === category);
			return acc;
		}, {});

		res.json({
			success: true,
			data: {
				products,
				groupedProducts,
				categories,
				total: products.length
			}
		});

	} catch (error) {
		console.error('Error fetching products:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy danh sách sản phẩm'
		});
	}
});

/**
 * @route   GET /api/products/direct-sales
 * @desc    Get products sellable at the counter (offline channel)
 * @access  Public
 */
// Seller/admin only: the counter list includes offline-only products, which
// the storefront hides, plus stock counts and SKUs.
router.get('/direct-sales', authenticateSeller, async (req, res) => {
	try {
		const { category, search } = req.query;
		const safeCategory = category !== 'all' ? asString(category, 100) : undefined;
		const searchMatch = safeSearch(search);

		const filter = {
			...(safeCategory && { category: safeCategory }),
			...(searchMatch && { $or: [{ name: searchMatch }, { description: searchMatch }] })
		};

		// Get products with sorting
		const products = await Product.findSellable('offline', filter)
			.sort({ category: 1, name: 1 })
			.lean();

		// Group products by category
		const categories = [...new Set(products.map(p => p.category))];
		const groupedProducts = categories.reduce((acc, category) => {
			acc[category] = products.filter(p => p.category === category);
			return acc;
		}, {});

		res.json({
			success: true,
			data: {
				products,
				groupedProducts,
				categories,
				total: products.length
			}
		});

	} catch (error) {
		console.error('Error fetching direct-sales products:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy danh sách sản phẩm bán trực tiếp'
		});
	}
});

/**
 * @route   GET /api/products/:id
 * @desc    Get a product sellable online (storefront detail)
 * @access  Public
 */
router.get('/:id', async (req, res) => {
	try {
		// Stock level, SKU and the deprecated isActive flag are internal; the
		// public detail page has no use for them.
		const [product] = await Product.findSellable('online', { _id: req.params.id })
			.select('-stockQuantity -sku -isActive')
			.limit(1)
			.lean();

		if (!product) {
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy sản phẩm'
			});
		}

		res.json({
			success: true,
			data: product
		});

	} catch (error) {
		console.error('Error fetching product:', error);

		if (error.name === 'CastError') {
			return res.status(400).json({
				success: false,
				message: 'ID sản phẩm không hợp lệ'
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thông tin sản phẩm'
		});
	}
});

/**
 * @route   GET /api/products/categories/list
 * @desc    Get all product categories
 * @access  Public
 */
router.get('/categories/list', async (req, res) => {
	try {
		const categories = await Product.distinct('category');

		res.json({
			success: true,
			data: categories.sort()
		});

	} catch (error) {
		console.error('Error fetching categories:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy danh sách danh mục'
		});
	}
});

module.exports = router;
