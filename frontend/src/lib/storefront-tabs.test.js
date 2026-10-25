import { describe, it, expect } from 'vitest';
import {
	isGateError,
	isStorefrontAccessError,
	pickLandingSlug,
	storefrontPath,
} from './storefront-tabs';

const OPEN = { id: '1', slug: 'public', accessible: true, locked: false };
const LOCKED = { id: '2', slug: 'club', accessible: false, locked: true };

describe('pickLandingSlug', () => {
	it('opens the first storefront the viewer can enter', () => {
		expect(pickLandingSlug([LOCKED, OPEN])).toBe('public');
	});

	it('falls back to the first one so its gate can ask for sign-in', () => {
		expect(pickLandingSlug([LOCKED])).toBe('club');
	});

	it('returns null when nothing is open', () => {
		expect(pickLandingSlug([])).toBeNull();
		expect(pickLandingSlug(undefined)).toBeNull();
	});
});

describe('storefrontPath', () => {
	it('builds the tab URL', () => {
		expect(storefrontPath('club')).toBe('/s/club');
	});
});

describe('isGateError', () => {
	it('matches the storefront 401/403 only', () => {
		expect(isGateError({ status: 401, code: 'STOREFRONT_LOGIN_REQUIRED' })).toBe(true);
		expect(isGateError({ status: 403, code: 'STOREFRONT_FORBIDDEN' })).toBe(true);
		expect(isGateError({ status: 403, code: 'STOREFRONT_ORDER_FORBIDDEN' })).toBe(false);
		expect(isGateError({ status: 401, code: 'UNAUTHORIZED' })).toBe(false);
		expect(isGateError({ status: 404, code: 'STOREFRONT_NOT_FOUND' })).toBe(false);
		expect(isGateError(null)).toBe(false);
	});
});

describe('isStorefrontAccessError', () => {
	it('covers checkout rejections that send the customer back to the storefront', () => {
		expect(isStorefrontAccessError({ code: 'ORDER_MIXED_STOREFRONTS' })).toBe(true);
		expect(isStorefrontAccessError({ code: 'STOREFRONT_ORDER_FORBIDDEN' })).toBe(true);
		expect(isStorefrontAccessError({ code: 'PRICE_CHANGED' })).toBe(false);
		expect(isStorefrontAccessError({})).toBe(false);
	});
});
