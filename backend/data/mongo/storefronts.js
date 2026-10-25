/**
 * Storefronts need the PostgreSQL store. This rollback store sells from one
 * public storefront that exists only here, in code: reads report it, access rules
 * do not exist (so nobody is admitted to anything private, because nothing is),
 * and every write is refused rather than silently dropped. Same precedent as
 * mail-settings.js.
 */
const { DEFAULT_STOREFRONT_ID, DEFAULT_STOREFRONT_SLUG, DEFAULT_STOREFRONT_NAME } = require('../default-storefront');

const SYNTHETIC = Object.freeze({
	_id: DEFAULT_STOREFRONT_ID,
	slug: DEFAULT_STOREFRONT_SLUG,
	name: DEFAULT_STOREFRONT_NAME,
	visibility: 'PUBLIC',
	sortOrder: 0,
	isActive: true
});

const copy = () => ({ ...SYNTHETIC });

async function unsupported() {
	throw new Error('not supported on the rollback store');
}

async function listActive() {
	return [copy()];
}

async function listAll() {
	return [copy()];
}

async function findBySlug(slug) {
	return slug === SYNTHETIC.slug ? copy() : null;
}

async function findById(id) {
	return String(id).toLowerCase() === SYNTHETIC._id ? copy() : null;
}

async function viewerCanAccess() {
	return false;
}

async function accessibleIds() {
	return [];
}

async function listRules() {
	return [];
}

module.exports = {
	listActive,
	listAll,
	findBySlug,
	findById,
	viewerCanAccess,
	accessibleIds,
	listRules,
	create: unsupported,
	update: unsupported,
	reorder: unsupported,
	remove: unsupported,
	addRule: unsupported,
	removeRule: unsupported
};
