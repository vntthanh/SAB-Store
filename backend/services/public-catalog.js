/**
 * The one place that decides what the public may see by code, and in what shape.
 *
 * "Public" means sellable online (`findSellable('online')`), the same rule the
 * storefront list uses. Every DTO is an explicit allow-list: online customers
 * never see stock, so no stock field (nor the `inStock` virtual) is ever added.
 */
const crypto = require('crypto');
const Product = require('../models/Product');
const Combo = require('../models/Combo');
const { mergeRequirements } = require('./combo-optimizer');
const { normalizePublicCode } = require('../utils/public-code');

const CHANNEL = 'online';
const OG_VERSION_LENGTH = 8;
const OG_COMBO_IMAGE_COUNT = 4;

// A document whose name was changed through a path that skips the slug hook has
// no slug yet; the code alone still makes a valid, resolvable URL.
const pathSegment = (thing) => thing.slug || thing.publicCode.toLowerCase();

const productPath = (product) => `/p/${product.publicCode}/${pathSegment(product)}`;
const comboPath = (combo) => `/c/${combo.publicCode}/${pathSegment(combo)}`;

// Exactly what toPublicProduct reads: stock and other internals never leave MongoDB.
const PUBLIC_PRODUCT_FIELDS = 'publicCode slug name description price imageUrl category available minOrderQuantity maxOrderQuantity';

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
		category: doc.category,
		available: doc.available,
		minOrderQuantity: doc.minOrderQuantity,
		maxOrderQuantity: doc.maxOrderQuantity
	};
}

/**
 * @param {object} doc a combo document
 * @param {object[]} products product documents eligible for the combo, in display order
 */
function toPublicCombo(doc, products) {
	const byCategory = new Map();
	for (const product of products) {
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

async function findPublicProductByCode(code) {
	const publicCode = normalizePublicCode(code);
	if (!publicCode) return null;
	const [product] = await Product.findSellable(CHANNEL, { publicCode }).limit(1).lean();
	return product ? toPublicProduct(product) : null;
}

// A combo that is on sale online but has no online product in a required
// category is still public: it shows its price with empty product lists.
async function findPublicComboByCode(code) {
	const publicCode = normalizePublicCode(code);
	if (!publicCode) return null;
	const [combo] = await Combo.findSellable(CHANNEL, { publicCode }).limit(1).lean();
	if (!combo) return null;

	const categories = [...new Set(combo.categoryRequirements.map((r) => r.category))];
	const products = await Product.find({ category: { $in: categories }, ...Product.sellableQuery(CHANNEL) })
		.select(PUBLIC_PRODUCT_FIELDS)
		.sort({ name: 1 })
		.lean();
	return toPublicCombo(combo, products);
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
	toPublicProduct,
	toPublicCombo,
	productPath,
	comboPath,
	comboImageUrls,
	ogVersion
};
