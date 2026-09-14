const express = require('express');
const Product = require('../models/Product');
const { asString, asEnum, safeSearch } = require('../utils/query-guard');
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

		// Filter by availability. `?available=all` used to bypass this filter
		// entirely (Q4, plan Phase 00 §B) — removed: every caller that wants
		// everything can query both values and merge, but nothing does.
		const query = {
			available: asEnum(available, ['false']) ? false : true,
			...(safeCategory && { category: safeCategory }),
			...(searchMatch && { $or: [{ name: searchMatch }, { description: searchMatch }] })
		};

		// Get products with sorting
		const products = await Product.find(query)
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
 * @desc    Get products available for direct sales (filters by isActive instead of available)
 * @access  Public
 */
router.get('/direct-sales', async (req, res) => {
	try {
		const { category, search } = req.query;
		const safeCategory = category !== 'all' ? asString(category, 100) : undefined;
		const searchMatch = safeSearch(search);

		// Build query - for direct sales, only filter by isActive (not available)
		const query = {
			isActive: true,  // Only active products can be sold in direct sales
			...(safeCategory && { category: safeCategory }),
			...(searchMatch && { $or: [{ name: searchMatch }, { description: searchMatch }] })
		};

		// Get products with sorting
		const products = await Product.find(query)
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
 * @desc    Get single product by ID
 * @access  Public
 */
router.get('/:id', async (req, res) => {
	try {
		const product = await Product.findById(req.params.id);

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
