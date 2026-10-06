/**
 * Share-preview data: the <head> fragment nginx splices into index.html, and the
 * lookup both the fragment and the image route use to decide what is public.
 */
const Settings = require('../models/Settings');
const { findPublicProductByCode, findPublicComboByCode, ogVersion } = require('./public-catalog');

const DESCRIPTION_MAX_LENGTH = 140;
const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function formatPrice(price) {
	const rounded = Math.round(Number(price) || 0);
	return `${String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
}

function truncate(text, max) {
	const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

// Absolute URLs come from configuration only. A Host header is attacker-chosen
// and the result is cached and shown to other people.
function baseUrl() {
	const value = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
	if (!value) throw new Error('BASE_URL is not configured');
	return value;
}

async function readStoreTitle() {
	const settings = await Settings.findOne({ key: Settings.SETTINGS_KEY }).select('storeTitle').lean();
	return (settings && settings.storeTitle) || Settings.DEFAULT_STORE_TITLE;
}

/** The public product or combo for a share URL, or null. `type` is 'p' or 'c'. */
function findPublicByType(type, code) {
	if (type === 'p') return findPublicProductByCode(code);
	if (type === 'c') return findPublicComboByCode(code);
	return Promise.resolve(null);
}

function describe(type, thing) {
	const price = formatPrice(thing.price);
	if (type === 'p') {
		const text = truncate(thing.description, DESCRIPTION_MAX_LENGTH);
		return text ? `${price} · ${text}` : price;
	}
	const summary = thing.requirements.map((r) => `${r.quantity} ${r.category}`).join(', ');
	return truncate(`Combo ${price} · ${summary}`, DESCRIPTION_MAX_LENGTH);
}

/**
 * @param {'p'|'c'} type
 * @param {object} thing a PublicProduct or PublicCombo
 * @param {string} storeTitle
 */
function renderMetaFragment(type, thing, storeTitle) {
	const base = baseUrl();
	const url = `${base}${thing.path}`;
	const image = `${base}/og/${type}/${thing.publicCode}.jpg?v=${ogVersion(thing)}`;
	const title = `${thing.name} — ${storeTitle}`;
	const description = describe(type, thing);

	const e = escapeHtml;
	return [
		`<title>${e(title)}</title>`,
		`<meta name="description" content="${e(description)}" />`,
		`<link rel="canonical" href="${e(url)}" />`,
		`<meta property="og:type" content="${type === 'p' ? 'product' : 'website'}" />`,
		`<meta property="og:site_name" content="${e(storeTitle)}" />`,
		`<meta property="og:url" content="${e(url)}" />`,
		`<meta property="og:title" content="${e(title)}" />`,
		`<meta property="og:description" content="${e(description)}" />`,
		`<meta property="og:image" content="${e(image)}" />`,
		`<meta property="og:image:width" content="${IMAGE_WIDTH}" />`,
		`<meta property="og:image:height" content="${IMAGE_HEIGHT}" />`,
		'<meta property="og:image:type" content="image/jpeg" />',
		`<meta property="og:image:alt" content="${e(thing.name)}" />`,
		'<meta property="og:locale" content="vi_VN" />',
		'<meta name="twitter:card" content="summary_large_image" />',
		`<meta name="twitter:title" content="${e(title)}" />`,
		`<meta name="twitter:description" content="${e(description)}" />`,
		`<meta name="twitter:image" content="${e(image)}" />`
	].join('\n');
}

/** The fragment for a share URL, or null when the thing is not public. */
async function buildMetaFragment(type, code) {
	const thing = await findPublicByType(type, code);
	if (!thing) return null;
	return renderMetaFragment(type, thing, await readStoreTitle());
}

module.exports = {
	findPublicByType,
	buildMetaFragment
};
