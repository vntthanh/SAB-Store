const express = require('express');
const { asEnum, asString } = require('../utils/query-guard');
const { buildMetaFragment, findPublicByType } = require('../services/og-meta');
const { ogVersion } = require('../services/public-catalog');
const { renderOgImage, OgBusyError } = require('../services/og-image');
const router = express.Router();

const TYPES = ['p', 'c'];
const META_CACHE_CONTROL = 'public, max-age=300';
// Not `immutable`: hiding a product has to make its preview expire (nginx keeps a
// rendered image at most a day).
const IMAGE_CACHE_CONTROL = 'public, max-age=86400';

// nginx splices these responses into a page or serves them as an image. Any
// failure must therefore be an empty body, never the JSON the global error
// handler would send, so this router answers every error itself.
const empty = (res, status) => res.status(status).end();

function fail(label, error, res) {
	if (error instanceof OgBusyError) return empty(res, 503);
	console.error(`[Share] ${label} failed:`, error);
	return empty(res, 500);
}

/**
 * @route   GET /api/share/meta?type=p|c&code=X
 * @desc    <head> fragment for a product or combo page
 * @access  Internal (nginx subrequest; blocked from outside)
 */
router.get('/meta', async (req, res) => {
	try {
		const type = asEnum(req.query.type, TYPES);
		const code = asString(req.query.code, 32);
		if (!type || !code) return empty(res, 404);

		const fragment = await buildMetaFragment(type, code);
		if (!fragment) return empty(res, 404);

		res.set({
			'Content-Type': 'text/html; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': META_CACHE_CONTROL
		});
		res.send(fragment);
	} catch (error) {
		fail('meta', error, res);
	}
});

/**
 * @route   GET /api/share/image/:type/:code.jpg?v=V
 * @desc    1200x630 preview image, rendered only for the current version
 * @access  Internal (nginx proxy; blocked from outside)
 */
router.get('/image/:type/:code.jpg', async (req, res) => {
	try {
		const type = asEnum(req.params.type, TYPES);
		if (!type) return empty(res, 404);

		const thing = await findPublicByType(type, req.params.code);
		// Checked before any rendering: a random `v` must not buy a render.
		if (!thing || req.query.v !== ogVersion(thing)) return empty(res, 404);

		const jpeg = await renderOgImage(thing);
		res.set({
			'Content-Type': 'image/jpeg',
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': IMAGE_CACHE_CONTROL
		});
		res.send(jpeg);
	} catch (error) {
		fail('image', error, res);
	}
});

module.exports = router;
