const express = require('express');
const Product = require('../models/Product');
const { asString, safeSearch } = require('../utils/query-guard');
const { authenticateSeller } = require('../middleware/better-auth');
const { findPublicProductByCode, toPublicProduct } = require('../services/public-catalog');
const { ErrorResponse } = require('../utils/errorResponse');
const ErrorLogger = require('../utils/errorLogger');
const router = express.Router();

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

// One body for every "not public" reason (missing, stopped, counter-only,
// malformed): a caller must not be able to tell a hidden product from an absent one.
const sendProductNotFound = (req, res) => res
	.status(404)
	.json(ErrorResponse.formatErrorResponse(ErrorResponse.notFoundError('Sản phẩm'), req));

// Online customers never learn stock levels: out of stock never blocks an
// order, so the number would only mislead. SKU and the retired isActive flag
// are internal too.
const PUBLIC_PRODUCT_HIDDEN_FIELDS = '-stockQuantity -sku -isActive';

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
			.select(PUBLIC_PRODUCT_HIDDEN_FIELDS)
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
 * @route   GET /api/products/by-code/:code
 * @desc    Get a product sellable online by its public code
 * @access  Public
 */
router.get('/by-code/:code', async (req, res) => {
	try {
		const product = await findPublicProductByCode(req.params.code);
		if (!product) return sendProductNotFound(req, res);

		res.set('Cache-Control', 'public, max-age=60');
		res.json({ success: true, data: product });
	} catch (error) {
		ErrorLogger.logRoute('GET /products/by-code/:code', error, req);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy thông tin sản phẩm'
		});
	}
});

/**
 * @route   GET /api/products/:id
 * @desc    Get a product sellable online (same public shape as by-code)
 * @access  Public
 */
router.get('/:id', async (req, res) => {
	try {
		if (!OBJECT_ID_PATTERN.test(req.params.id)) return sendProductNotFound(req, res);

		const [product] = await Product.findSellable('online', { _id: req.params.id })
			.limit(1)
			.lean();
		if (!product) return sendProductNotFound(req, res);

		res.json({ success: true, data: toPublicProduct(product) });
	} catch (error) {
		ErrorLogger.logRoute('GET /products/:id', error, req);
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
