const express = require('express');
const { products: productRepo, combos: comboRepo, storefronts: storefrontRepo } = require('../data');
const { asString } = require('../utils/query-guard');
const { authenticateOptional } = require('../middleware/better-auth');
const { toCatalogCombo } = require('../services/public-catalog');
const {
	describeAccess, assertCanView, canOrder, StorefrontAccessError, sendAccessError
} = require('../services/storefront-access');
const ErrorLogger = require('../utils/errorLogger');
const { ERROR_CODES } = require('../constants/errorCodes');
const { sendCoded } = require('./admin/storefront-params');
const router = express.Router();

// Both answers depend on who asks, so no shared cache may keep them.
const NO_STORE = 'private, no-store';

const toPublicStorefront = ({ _id, slug, name, description, visibility }) => ({
	id: _id,
	slug,
	name,
	...(description !== undefined && { description }),
	visibility
});

/**
 * @route   GET /api/storefronts
 * @desc    Active storefronts in display order. A private one is listed to everyone
 *          (as `locked` unless the viewer may see it) so the tab can ask for sign-in.
 * @access  Public
 */
router.get('/', authenticateOptional, async (req, res) => {
	try {
		const list = await storefrontRepo.listActive();
		const access = await describeAccess(list, req.viewer);

		res.set('Cache-Control', NO_STORE);
		res.json({
			success: true,
			data: {
				storefronts: list.map((storefront) => {
					const { canView, canOrder: orderable } = access.get(storefront._id);
					return {
						...toPublicStorefront(storefront),
						locked: storefront.visibility === 'PRIVATE' && !canView,
						accessible: canView,
						canOrder: orderable
					};
				})
			}
		});
	} catch (error) {
		ErrorLogger.logRoute('GET /storefronts', error, req);
		sendCoded(res, ERROR_CODES.INTERNAL_SERVER_ERROR);
	}
});

/**
 * @route   GET /api/storefronts/:slug/catalog
 * @desc    The products and combos of one storefront, after its access check
 * @access  Public (private storefronts: a viewer an access rule admits, or staff previewing)
 */
router.get('/:slug/catalog', authenticateOptional, async (req, res) => {
	try {
		const storefront = await storefrontRepo.findBySlug(asString(req.params.slug, 60));
		await assertCanView(storefront, req.viewer);

		const { category, search } = req.query;
		const safeCategory = category !== 'all' ? asString(category, 100) : undefined;

		const [products, combos, orderable] = await Promise.all([
			productRepo.listSellable('online', {
				storefrontId: storefront._id,
				category: safeCategory,
				search: asString(search, 100),
				// Online customers never learn stock levels.
				forCustomers: true
			}),
			comboRepo.listSellable('online', { storefrontId: storefront._id }),
			canOrder(storefront, req.viewer)
		]);

		const categories = [...new Set(products.map((product) => product.category))];
		const groupedProducts = categories.reduce((acc, name) => {
			acc[name] = products.filter((product) => product.category === name);
			return acc;
		}, {});

		if (storefront.visibility !== 'PUBLIC' || !storefront.isActive) res.set('Cache-Control', NO_STORE);
		res.json({
			success: true,
			data: {
				storefront: toPublicStorefront(storefront),
				products,
				groupedProducts,
				categories,
				total: products.length,
				combos: combos.map(toCatalogCombo),
				canOrder: orderable
			}
		});
	} catch (error) {
		if (error instanceof StorefrontAccessError) return sendAccessError(res, error);
		ErrorLogger.logRoute('GET /storefronts/:slug/catalog', error, req);
		sendCoded(res, ERROR_CODES.INTERNAL_SERVER_ERROR);
	}
});

module.exports = router;
