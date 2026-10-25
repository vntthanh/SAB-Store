const express = require('express');
const { products: productRepo } = require('../data');
const { isRecordId } = require('../data/ids');
const { asString } = require('../utils/query-guard');
const { authenticateSeller } = require('../middleware/better-auth');
const { findViewableProductByCode, viewProduct, onlyOpenProducts } = require('../services/public-catalog');
const { resolveViewer, isStaff, StorefrontAccessError, sendAccessError } = require('../services/storefront-access');
const { ErrorResponse } = require('../utils/errorResponse');
const ErrorLogger = require('../utils/errorLogger');
const router = express.Router();


// One body for every "not public" reason (missing, stopped, counter-only,
// malformed): a caller must not be able to tell a hidden product from an absent one.
const sendProductNotFound = (req, res) => res
	.status(404)
	.json(ErrorResponse.formatErrorResponse(ErrorResponse.notFoundError('Sản phẩm'), req));

/**
 * @route   GET /api/products
 * @desc    Get all products
 * @access  Public
 */
router.get('/', async (req, res) => {
	try {
		const { category, search, available } = req.query;
		const safeCategory = category !== 'all' ? asString(category, 100) : undefined;

		// The public storefront is the online channel; no query parameter
		// widens it (a stopped product must never be listed publicly).
		// Only storefronts open to everyone: a private storefront is read through
		// /api/storefronts/:slug/catalog, behind its access check.
		const products = await onlyOpenProducts(await productRepo.listSellable('online', {
			category: safeCategory,
			search: asString(search, 100),
			// Online customers never learn stock levels: out of stock never blocks
			// an order, so the number would only mislead.
			forCustomers: true
		}));

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

		const products = await productRepo.listSellable('offline', {
			category: safeCategory,
			search: asString(search, 100)
		});

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
		const found = await findViewableProductByCode(req.params.code, await resolveViewer(req));
		if (!found) return sendProductNotFound(req, res);

		// A private storefront's product depends on who asks, so a shared cache must not keep it.
		res.set('Cache-Control', found.cacheable ? 'public, max-age=60' : 'private, no-store');
		res.json({ success: true, data: found.data });
	} catch (error) {
		if (error instanceof StorefrontAccessError) return sendAccessError(res, error);
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
		if (!isRecordId(req.params.id)) return sendProductNotFound(req, res);

		const [product] = await productRepo.findSellable('online', { id: req.params.id });
		if (!product) return sendProductNotFound(req, res);

		const { data, cacheable } = await viewProduct(product, await resolveViewer(req));
		if (!cacheable) res.set('Cache-Control', 'private, no-store');
		res.json({ success: true, data });
	} catch (error) {
		if (error instanceof StorefrontAccessError) return sendAccessError(res, error);
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
		// The admin product form picks from every category in use. Everyone else gets
		// the open storefronts' categories only: a category name can give away a private item.
		let categories;
		if (isStaff(await resolveViewer(req))) {
			categories = await productRepo.listCategories();
		} else {
			const products = await onlyOpenProducts(await productRepo.listSellable('online', { forCustomers: true }));
			categories = [...new Set(products.map((product) => product.category))];
		}

		// Staff and everyone else get different lists, so no shared cache may keep one.
		res.set('Cache-Control', 'private, no-store');
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
