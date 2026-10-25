/**
 * The one place that decides who may see and who may order from a storefront.
 *
 * Seeing and ordering differ on purpose: staff (admin, seller) preview any
 * storefront, but only a verified email that an access rule admits may place an
 * order in a PRIVATE one. Nothing here caches: a rule removed a moment ago must
 * block the very next request.
 */
const { storefronts, products } = require('../data');
const { isRecordId, normalizeRecordId } = require('../data/ids');
const { ERROR_CODES, ERROR_MESSAGES, ERROR_CODE_TO_HTTP_STATUS } = require('../constants/errorCodes');
const { PricingError } = require('./pricing');
const { isStaffRole } = require('../lib/auth-guards');

class StorefrontAccessError extends Error {
	/**
	 * @param {string} code an ERROR_CODES.STOREFRONT_* value
	 * @param {{slug: string, name: string}} [storefront] named in 401/403 bodies only
	 */
	constructor(code, storefront) {
		super(code);
		this.name = 'StorefrontAccessError';
		this.code = code;
		if (storefront) this.storefront = { slug: storefront.slug, name: storefront.name };
	}
}

/**
 * The signed-in visitor as `{ id, email, emailVerified, role }`, or null.
 * Reads `req.viewer` when authenticateOptional ran; otherwise asks the session.
 * A session that cannot be read is anonymous, never an open door.
 */
async function resolveViewer(req) {
	if (req.viewer !== undefined) return req.viewer;
	try {
		// Loaded on use: lib/auth validates its secrets at require time.
		const { auth } = require('../lib/auth');
		const session = await auth.api.getSession({ headers: req.headers });
		if (!session?.user) return null;
		const { id, email, emailVerified, role } = session.user;
		return { id, email, emailVerified: emailVerified === true, role };
	} catch (error) {
		console.error('Viewer resolution error:', error);
		return null;
	}
}

const isStaff = (viewer) => Boolean(viewer) && isStaffRole(viewer.role);

const isPublic = (storefront) => storefront.visibility === 'PUBLIC';

/** An unverified address proves nothing, so it never matches a rule. */
async function admitsViewer(storefront, viewer, tx) {
	if (!viewer || viewer.emailVerified !== true || !viewer.email) return false;
	return storefronts.viewerCanAccess(storefront._id, viewer.email, tx);
}

/** May `viewer` browse this storefront's catalog? Staff preview everything. */
async function canView(storefront, viewer, tx) {
	if (!storefront) return false;
	const staff = isStaff(viewer);
	if (!storefront.isActive) return staff;
	if (isPublic(storefront) || staff) return true;
	return admitsViewer(storefront, viewer, tx);
}

/** May `viewer` place an order here? No staff bypass in a PRIVATE storefront. */
async function canOrder(storefront, viewer, tx) {
	if (!storefront || !storefront.isActive) return false;
	if (isPublic(storefront)) return true;
	return admitsViewer(storefront, viewer, tx);
}

// Whether the viewer exists at all picks 401 (sign in) over 403 (this account is not admitted).
const denial = (storefront, viewer, forbiddenCode) =>
	viewer
		? new StorefrontAccessError(forbiddenCode, storefront)
		: new StorefrontAccessError(ERROR_CODES.STOREFRONT_LOGIN_REQUIRED, storefront);

/**
 * @throws {StorefrontAccessError} STOREFRONT_NOT_FOUND (absent, or inactive for non-staff),
 *   STOREFRONT_LOGIN_REQUIRED, STOREFRONT_FORBIDDEN
 */
async function assertCanView(storefront, viewer, tx) {
	if (!storefront || (!storefront.isActive && !isStaff(viewer))) {
		throw new StorefrontAccessError(ERROR_CODES.STOREFRONT_NOT_FOUND);
	}
	if (!(await canView(storefront, viewer, tx))) throw denial(storefront, viewer, ERROR_CODES.STOREFRONT_FORBIDDEN);
}

/**
 * @throws {StorefrontAccessError} STOREFRONT_NOT_FOUND (absent or inactive, staff included),
 *   STOREFRONT_LOGIN_REQUIRED, STOREFRONT_ORDER_FORBIDDEN
 */
async function assertCanOrder(storefront, viewer, tx) {
	if (!storefront || !storefront.isActive) throw new StorefrontAccessError(ERROR_CODES.STOREFRONT_NOT_FOUND);
	if (!(await canOrder(storefront, viewer, tx))) throw denial(storefront, viewer, ERROR_CODES.STOREFRONT_ORDER_FORBIDDEN);
}

/**
 * The distinct storefront ids (null: a product with none) of the products a cart
 * names, read before any price or product name is worked out. Ids that are not
 * record ids are left for pricing to refuse.
 */
async function cartStorefrontIds(items, tx) {
	const ids = [...new Set((Array.isArray(items) ? items : [])
		.map((item) => item && item.productId)
		.filter(isRecordId)
		.map(normalizeRecordId))];
	return ids.length === 0 ? [] : products.storefrontIdsOf(ids, tx);
}

/** The cart's storefronts that need a check; an active PUBLIC one is open to every viewer. */
async function restrictedStorefronts(ids, tx) {
	const found = await Promise.all(ids.filter((id) => id !== null).map((id) => storefronts.findById(id, tx)));
	return found.filter((storefront) => !storefront || storefront.visibility !== 'PUBLIC' || !storefront.isActive);
}

/**
 * Gate for an online order, run before the cart is priced: pricing errors name
 * products and prices, which a caller without access must never learn.
 *
 * @throws {PricingError} ORDER_MIXED_STOREFRONTS when the cart spans storefronts
 * @throws {StorefrontAccessError} see assertCanOrder
 */
async function assertCanOrderCart(items, viewer, tx) {
	const ids = await cartStorefrontIds(items, tx);
	if (ids.length > 1) throw new PricingError(ERROR_CODES.ORDER_MIXED_STOREFRONTS);
	for (const storefront of await restrictedStorefronts(ids, tx)) await assertCanOrder(storefront, viewer, tx);
}

/**
 * Gate for a price preview, run before pricing: a private storefront's prices are
 * part of its catalog.
 *
 * @throws {StorefrontAccessError} see assertCanView, for the first storefront `viewer` may not see
 */
async function assertCanViewCart(items, viewer, tx) {
	const ids = await cartStorefrontIds(items, tx);
	for (const storefront of await restrictedStorefronts(ids, tx)) await assertCanView(storefront, viewer, tx);
}

/**
 * What `viewer` may do in each of `list`, as Map(storefront id -> {canView, canOrder}).
 * One rule query for the whole list instead of one per private storefront.
 */
async function describeAccess(list, viewer, tx) {
	const verified = Boolean(viewer && viewer.emailVerified === true && viewer.email);
	const admitted = new Set(verified ? await storefronts.accessibleIds(viewer.email, tx) : []);
	const staff = isStaff(viewer);

	return new Map(list.map((storefront) => {
		const open = isPublic(storefront);
		const allowed = storefront.isActive ? open || admitted.has(storefront._id) : false;
		return [storefront._id, {
			canView: storefront.isActive ? open || staff || allowed : staff,
			canOrder: allowed
		}];
	}));
}

/** Replies with the error's status and Vietnamese message; 401/403 name the storefront. */
function sendAccessError(res, error) {
	return res.status(ERROR_CODE_TO_HTTP_STATUS[error.code]).json({
		success: false,
		message: ERROR_MESSAGES[error.code].vi,
		code: error.code,
		...(error.storefront && { storefront: error.storefront })
	});
}

module.exports = {
	StorefrontAccessError,
	resolveViewer,
	isStaff,
	canView,
	canOrder,
	assertCanView,
	assertCanOrder,
	assertCanOrderCart,
	assertCanViewCart,
	describeAccess,
	sendAccessError
};
