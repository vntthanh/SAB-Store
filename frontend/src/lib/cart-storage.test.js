import { describe, it, expect } from 'vitest';
import {
	ACTIVE_STOREFRONT_KEY,
	DEFAULT_STOREFRONT_ID,
	LEGACY_CART_KEY,
	cartKey,
	clearPrivateCarts,
	loadCart,
	migrateLegacyCart,
	normalizeStorefront,
	readActiveStorefront,
	saveCart,
	writeActiveStorefront,
} from './cart-storage';

const makeStorage = (initial = {}) => {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => data.set(key, String(value)),
		removeItem: (key) => data.delete(key),
		get length() {
			return data.size;
		},
		key: (index) => [...data.keys()][index] ?? null,
	};
};

const LINE = { productId: 'p1', productName: 'Bánh', price: 10000, quantity: 2 };

describe('migrateLegacyCart', () => {
	it('moves the old single cart to the default storefront, once', () => {
		const storage = makeStorage({ [LEGACY_CART_KEY]: JSON.stringify({ items: [LINE] }) });

		migrateLegacyCart(storage);

		expect(storage.data.has(LEGACY_CART_KEY)).toBe(false);
		expect(loadCart(storage, DEFAULT_STOREFRONT_ID)).toEqual([LINE]);

		migrateLegacyCart(storage);
		expect(loadCart(storage, DEFAULT_STOREFRONT_ID)).toEqual([LINE]);
	});

	it('does not overwrite a cart already saved under the new key', () => {
		const newer = { ...LINE, quantity: 5 };
		const storage = makeStorage({
			[LEGACY_CART_KEY]: JSON.stringify({ items: [LINE] }),
			[cartKey(DEFAULT_STOREFRONT_ID)]: JSON.stringify({ items: [newer] }),
		});

		migrateLegacyCart(storage);

		expect(loadCart(storage, DEFAULT_STOREFRONT_ID)).toEqual([newer]);
		expect(storage.data.has(LEGACY_CART_KEY)).toBe(false);
	});

	it('drops an unreadable legacy cart instead of carrying it over', () => {
		const storage = makeStorage({ [LEGACY_CART_KEY]: '{not json' });

		migrateLegacyCart(storage);

		expect(storage.data.has(LEGACY_CART_KEY)).toBe(false);
		expect(loadCart(storage, DEFAULT_STOREFRONT_ID)).toEqual([]);
	});

	it('does nothing without a legacy cart', () => {
		const storage = makeStorage();
		migrateLegacyCart(storage);
		expect(storage.data.size).toBe(0);
	});
});

describe('per-storefront carts', () => {
	it('keeps one cart per storefront id', () => {
		const storage = makeStorage();
		saveCart(storage, 'store-a', [LINE]);
		saveCart(storage, 'store-b', [{ ...LINE, productId: 'p2' }]);

		expect(loadCart(storage, 'store-a')).toEqual([LINE]);
		expect(loadCart(storage, 'store-b')).toEqual([{ ...LINE, productId: 'p2' }]);
		expect(loadCart(storage, 'store-c')).toEqual([]);
	});

	it('discards lines that are not a product with a positive whole quantity', () => {
		const storage = makeStorage({
			[cartKey('s')]: JSON.stringify({ items: [LINE, { productId: 'x', quantity: 0 }, { quantity: 1 }, null, { productId: 'y', quantity: 1.5 }] }),
		});
		expect(loadCart(storage, 's')).toEqual([LINE]);
	});

	it('survives a storage that throws', () => {
		const broken = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
			removeItem: () => {
				throw new Error('blocked');
			},
		};
		expect(loadCart(broken, 's')).toEqual([]);
		expect(() => saveCart(broken, 's', [LINE])).not.toThrow();
		expect(() => migrateLegacyCart(broken)).not.toThrow();
		expect(readActiveStorefront(broken)).toBeNull();
	});
});

describe('active storefront', () => {
	it('round-trips and defaults canOrder to true', () => {
		const storage = makeStorage();
		writeActiveStorefront(storage, normalizeStorefront({ id: 's1', slug: 'club', name: 'Club', visibility: 'PRIVATE' }));

		expect(readActiveStorefront(storage)).toEqual({ id: 's1', slug: 'club', name: 'Club', visibility: 'PRIVATE', canOrder: true });
	});

	it('keeps an explicit canOrder false', () => {
		expect(normalizeStorefront({ id: 's1', canOrder: false }).canOrder).toBe(false);
	});

	it('ignores a stored value without an id', () => {
		const storage = makeStorage({ [ACTIVE_STOREFRONT_KEY]: JSON.stringify({ slug: 'x' }) });
		expect(readActiveStorefront(storage)).toBeNull();
	});
});

describe('clearPrivateCarts', () => {
	it('removes private storefront carts and keeps public and unrelated keys', () => {
		const storage = makeStorage();
		saveCart(storage, 'private-1', [LINE], 'PRIVATE');
		saveCart(storage, 'public-1', [LINE], 'PUBLIC');
		saveCart(storage, DEFAULT_STOREFRONT_ID, [LINE]);
		storage.setItem('unrelated', 'x');

		clearPrivateCarts(storage);

		expect(loadCart(storage, 'private-1')).toEqual([]);
		expect(storage.data.has(cartKey('private-1'))).toBe(false);
		expect(loadCart(storage, 'public-1')).toEqual([LINE]);
		expect(loadCart(storage, DEFAULT_STOREFRONT_ID)).toEqual([LINE]);
		expect(storage.data.get('unrelated')).toBe('x');
	});

	it('survives a cart that is not JSON and a storage that throws', () => {
		const storage = makeStorage({ [cartKey('bad')]: '{nope' });
		expect(() => clearPrivateCarts(storage)).not.toThrow();
		expect(() => clearPrivateCarts({ get length() { throw new Error('blocked'); } })).not.toThrow();
	});
});
