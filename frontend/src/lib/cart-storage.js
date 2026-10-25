// The storefront every pre-existing cart belonged to; the backend migration seeds it with this id.
export const DEFAULT_STOREFRONT_ID = '01a173f3-7280-71fd-b24f-118da6196e35';
export const LEGACY_CART_KEY = 'minipreorder_cart';
export const ACTIVE_STOREFRONT_KEY = 'minipreorder_active_storefront';

export const cartKey = (storefrontId) => `${LEGACY_CART_KEY}:${storefrontId}`;

// Storage can throw (private mode, blocked site data); a cart that cannot be
// saved still works for the session, so failures degrade to "nothing stored".
const read = (storage, key) => {
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
};
const write = (storage, key, value) => {
	try {
		storage.setItem(key, value);
	} catch {
		// Not persisted; the cart lives on in memory.
	}
};
const remove = (storage, key) => {
	try {
		storage.removeItem(key);
	} catch {
		// Nothing to clean up.
	}
};

const isLine = (line) =>
	line && typeof line.productId === 'string' && Number.isInteger(line.quantity) && line.quantity > 0;

const parseItems = (raw) => {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed?.items) ? parsed.items.filter(isLine) : [];
	} catch {
		return [];
	}
};

/**
 * Moves the single pre-storefront cart to the default storefront's key, once.
 * A cart already saved under the new key is newer, so the old one is only dropped.
 */
export const migrateLegacyCart = (storage) => {
	const legacy = read(storage, LEGACY_CART_KEY);
	if (legacy === null) return;
	if (read(storage, cartKey(DEFAULT_STOREFRONT_ID)) === null) {
		write(storage, cartKey(DEFAULT_STOREFRONT_ID), JSON.stringify({ items: parseItems(legacy) }));
	}
	remove(storage, LEGACY_CART_KEY);
};

export const loadCart = (storage, storefrontId) => parseItems(read(storage, cartKey(storefrontId)));

// `visibility` is stored beside the lines so a sign-out can find the carts of private
// storefronts without knowing the storefront list (which it may no longer be allowed to read).
export const saveCart = (storage, storefrontId, items, visibility = 'PUBLIC') => {
	write(storage, cartKey(storefrontId), JSON.stringify({ items, visibility }));
};

const CART_KEY_PREFIX = `${LEGACY_CART_KEY}:`;

/**
 * Forgets the carts of private storefronts: a shared computer must not hand the next
 * person the previous customer's lines. Public carts are not tied to an account and stay.
 */
export const clearPrivateCarts = (storage) => {
	const keys = [];
	try {
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (key && key.startsWith(CART_KEY_PREFIX)) keys.push(key);
		}
	} catch {
		return;
	}
	for (const key of keys) {
		try {
			if (JSON.parse(read(storage, key))?.visibility === 'PRIVATE') remove(storage, key);
		} catch {
			// An unreadable cart is dropped on load anyway.
		}
	}
};

/** Only the fields the cart needs to remember about its storefront. */
export const normalizeStorefront = (storefront) => ({
	id: storefront.id,
	slug: storefront.slug ?? null,
	name: storefront.name ?? '',
	visibility: storefront.visibility ?? 'PUBLIC',
	canOrder: storefront.canOrder !== false,
});

export const sameStorefront = (a, b) =>
	a.id === b.id && a.slug === b.slug && a.name === b.name && a.visibility === b.visibility && a.canOrder === b.canOrder;

export const readActiveStorefront = (storage) => {
	const raw = read(storage, ACTIVE_STOREFRONT_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed?.id === 'string' && parsed.id ? normalizeStorefront(parsed) : null;
	} catch {
		return null;
	}
};

export const writeActiveStorefront = (storage, storefront) => {
	write(storage, ACTIVE_STOREFRONT_KEY, JSON.stringify(storefront));
};
