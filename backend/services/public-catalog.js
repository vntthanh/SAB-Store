/**
 * The one place that decides what the public may see by code, and in what shape.
 *
 * "Public" means sellable online (`findSellable('online')`) in a storefront open to
 * everyone; the `view*` functions widen that to what one viewer may see. Every DTO is an explicit allow-list: online customers
 * never see stock, so no stock field (nor the `inStock` virtual) is ever added.
 */
const crypto = require('crypto');
const { products, combos, storefronts } = require('../data');
const { DEFAULT_STOREFRONT_ID } = require('../data/default-storefront');
const { ERROR_CODES } = require('../constants/errorCodes');
const { StorefrontAccessError, assertCanView, canView, describeAccess } = require('./storefront-access');
const { mergeRequirements } = require('./combo-optimizer');
const { normalizePublicCode } = require('../utils/public-code');
const FALLBACK_IMAGE = '/fallback-product.png';

const CHANNEL = 'online';
const OG_VERSION_LENGTH = 8;
const OG_COMBO_IMAGE_COUNT = 4;

// A document whose name was changed through a path that skips the slug hook has
// no slug yet; the code alone still makes a valid, resolvable URL.
const pathSegment = (thing) => thing.slug || thing.publicCode.toLowerCase();

const productPath = (product) => `/p/${product.publicCode}/${pathSegment(product)}`;
const comboPath = (combo) => `/c/${combo.publicCode}/${pathSegment(combo)}`;

// Exactly what toPublicProduct reads, plus the storefront used to filter by access (never
// output): stock and other internals are never loaded.
const PUBLIC_PRODUCT_FIELDS = [
	'storefrontId', 'publicCode', 'slug', 'name', 'description', 'price', 'imageUrl', 'category', 'available', 'minOrderQuantity', 'maxOrderQuantity',
	'images', 'options', 'variants'
];

// What a customer may know of a variant: never its stock or SKU, and only the
// active ones. A store without variants (the Mongo rollback) lists none.
function toPublicVariants(doc) {
	return (doc.variants ?? [])
		.filter((variant) => variant.isActive !== false)
		.map((variant) => ({
			_id: variant._id,
			optionValues: variant.optionValues,
			...(variant.label && { label: variant.label }),
			effectivePrice: variant.effectivePrice ?? doc.price,
			...(variant.imageUrl && { imageUrl: variant.imageUrl })
		}));
}

function toPublicProduct(doc) {
	return {
		_id: doc._id,
		publicCode: doc.publicCode,
		slug: pathSegment(doc),
		path: productPath(doc),
		name: doc.name,
		description: doc.description,
		price: doc.price,
		imageUrl: doc.imageUrl,
		images: doc.images ?? (doc.imageUrl && doc.imageUrl !== FALLBACK_IMAGE ? [doc.imageUrl] : []),
		options: doc.options ?? [],
		variants: toPublicVariants(doc),
		category: doc.category,
		available: doc.available,
		minOrderQuantity: doc.minOrderQuantity,
		maxOrderQuantity: doc.maxOrderQuantity
	};
}

/**
 * @param {object} doc a combo document
 * @param {object[]} eligible product records eligible for the combo, in display order
 */
function toPublicCombo(doc, eligible) {
	const byCategory = new Map();
	for (const product of eligible) {
		if (!byCategory.has(product.category)) byCategory.set(product.category, []);
		byCategory.get(product.category).push(toPublicProduct(product));
	}

	const requirements = [];
	for (const [category, quantity] of mergeRequirements(doc.categoryRequirements)) {
		requirements.push({ category, quantity, products: byCategory.get(category) || [] });
	}

	return {
		_id: doc._id,
		publicCode: doc.publicCode,
		slug: pathSegment(doc),
		path: comboPath(doc),
		name: doc.name,
		description: doc.description,
		price: doc.price,
		requirements
	};
}

const storefrontIdOf = (product) => product.storefrontId || DEFAULT_STOREFRONT_ID;
// The rollback store keeps no links: its combos sell from the one synthetic storefront.
const linkedIdsOf = (combo) => combo.storefrontIds || [DEFAULT_STOREFRONT_ID];

// Open to everyone, signed in or not.
const isOpen = (storefront) => Boolean(storefront && storefront.isActive && storefront.visibility === 'PUBLIC');

/** Ids of the active PUBLIC storefronts: the only ones an anonymous request may read. */
async function openStorefrontIds() {
	return new Set((await storefronts.listActive()).filter(isOpen).map((storefront) => storefront._id));
}

/** Only the products that belong to an open storefront. */
async function onlyOpenProducts(records) {
	const open = await openStorefrontIds();
	return records.filter((product) => open.has(storefrontIdOf(product)));
}

/** A combo as listed to customers; the storefront links stay server-side. */
function toCatalogCombo(combo) {
	const { storefrontIds, ...rest } = combo;
	return rest;
}

/** Only the combos linked to at least one open storefront. */
async function onlyOpenCombos(records) {
	const open = await openStorefrontIds();
	return records.filter((combo) => linkedIdsOf(combo).some((id) => open.has(id))).map(toCatalogCombo);
}

// Products a combo can take are those of the storefronts it is linked to and the
// viewer may see: a same-category product elsewhere must not leak through its list.
async function toPublicComboIn(combo, visibleStorefrontIds) {
	const categories = [...new Set(combo.categoryRequirements.map((r) => r.category))];
	const eligible = await products.listSellableInCategories(CHANNEL, categories, PUBLIC_PRODUCT_FIELDS);
	return toPublicCombo(combo, eligible.filter((product) => visibleStorefrontIds.has(storefrontIdOf(product))));
}

async function findSellableProductByCode(code) {
	const publicCode = normalizePublicCode(code);
	if (!publicCode) return null;
	const [product] = await products.findSellable(CHANNEL, { publicCode });
	return product || null;
}

// A combo that is on sale online but has no online product in a required
// category is still public: it shows its price with empty product lists.
async function findSellableComboByCode(code) {
	const publicCode = normalizePublicCode(code);
	if (!publicCode) return null;
	const [combo] = await combos.findSellable(CHANNEL, { publicCode });
	return combo || null;
}

/** The product when its storefront is open to everyone, else null (share previews, caches). */
async function findPublicProductByCode(code) {
	const product = await findSellableProductByCode(code);
	if (!product || !(await openStorefrontIds()).has(storefrontIdOf(product))) return null;
	return toPublicProduct(product);
}

/** The combo when at least one of its storefronts is open to everyone, else null. */
async function findPublicComboByCode(code) {
	const combo = await findSellableComboByCode(code);
	if (!combo) return null;
	const open = await openStorefrontIds();
	const visible = new Set(linkedIdsOf(combo).filter((id) => open.has(id)));
	return visible.size === 0 ? null : toPublicComboIn(combo, visible);
}

/**
 * The storefront a detail page adds to the cart of, in the shape the catalog uses.
 * Only built after the viewer passed the view check, so it never names a gated storefront.
 */
async function toStorefrontRef(storefront, viewer) {
	const { canOrder } = (await describeAccess([storefront], viewer)).get(storefront._id);
	return { id: storefront._id, slug: storefront.slug, name: storefront.name, visibility: storefront.visibility, canOrder };
}

/**
 * The product as `viewer` may see it.
 *
 * @returns {Promise<{data: object, cacheable: boolean}>} `cacheable`: the same body for every visitor
 * @throws {StorefrontAccessError}
 */
async function viewProduct(product, viewer) {
	const storefront = await storefronts.findById(storefrontIdOf(product));
	await assertCanView(storefront, viewer);
	return {
		data: { ...toPublicProduct(product), storefront: await toStorefrontRef(storefront, viewer) },
		cacheable: isOpen(storefront)
	};
}

/**
 * The combo as `viewer` may see it: any one viewable storefront is enough, and the
 * product lists only draw on the viewable ones.
 *
 * @returns {Promise<{data: object, cacheable: boolean}>} `cacheable`: the same body for every visitor
 * @throws {StorefrontAccessError}
 */
async function viewCombo(combo, viewer) {
	const linked = (await Promise.all(linkedIdsOf(combo).map((id) => storefronts.findById(id)))).filter(Boolean);
	const visible = [];
	for (const storefront of linked) {
		if (await canView(storefront, viewer)) visible.push(storefront);
	}
	if (visible.length === 0) {
		// Explains the refusal with the first live storefront (sign in, or not admitted).
		await assertCanView(linked.find((storefront) => storefront.isActive) || null, viewer);
		throw new StorefrontAccessError(ERROR_CODES.STOREFRONT_NOT_FOUND);
	}
	// The first storefront the viewer can open, a public one before a private one.
	const home = visible.find(isOpen) || visible[0];
	return {
		data: {
			...(await toPublicComboIn(combo, new Set(visible.map((storefront) => storefront._id)))),
			storefront: await toStorefrontRef(home, viewer)
		},
		cacheable: linked.every(isOpen)
	};
}

/** @returns {Promise<{data: object, cacheable: boolean}|null>} null when nothing sells under that code @throws {StorefrontAccessError} */
async function findViewableProductByCode(code, viewer) {
	const product = await findSellableProductByCode(code);
	return product ? viewProduct(product, viewer) : null;
}

/** @returns {Promise<{data: object, cacheable: boolean}|null>} null when nothing sells under that code @throws {StorefrontAccessError} */
async function findViewableComboByCode(code, viewer) {
	const combo = await findSellableComboByCode(code);
	return combo ? viewCombo(combo, viewer) : null;
}

/** The images that represent a combo in a share preview: sorted so the pick is stable. */
function comboImageUrls(publicCombo) {
	return publicCombo.requirements
		.flatMap((requirement) => requirement.products.map((product) => product.imageUrl))
		.sort()
		.slice(0, OG_COMBO_IMAGE_COUNT);
}

/**
 * Cache-buster for the share image: a function of the image inputs only, so it
 * changes when the picture would, and not on every order or stock change.
 */
function ogVersion(publicThing) {
	const urls = Array.isArray(publicThing.requirements) ? comboImageUrls(publicThing) : [publicThing.imageUrl || ''];
	return crypto.createHash('sha1').update(JSON.stringify(urls)).digest('hex').slice(0, OG_VERSION_LENGTH);
}

module.exports = {
	findPublicProductByCode,
	findPublicComboByCode,
	findViewableProductByCode,
	findViewableComboByCode,
	viewProduct,
	onlyOpenProducts,
	onlyOpenCombos,
	toCatalogCombo,
	toPublicProduct,
	comboImageUrls,
	ogVersion
};
