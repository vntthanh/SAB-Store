import { describe, it, expect, vi } from 'vitest';

// The tab bodies talk to the API; only the tab choice is under test.
vi.mock('./StorefrontManagement', () => ({ default: () => null }));
vi.mock('./EmailListManagement', () => ({ default: () => null }));
import { activeTabKey, ADMIN_STOREFRONT_TABS } from './StorefrontAdminPage';

describe('activeTabKey', () => {
	it('opens the email lists tab named in the URL', () => {
		expect(activeTabKey('email-lists')).toBe('email-lists');
	});

	it.each([null, '', 'unknown'])('falls back to the storefronts tab for %j', (param) => {
		expect(activeTabKey(param)).toBe(ADMIN_STOREFRONT_TABS[0].key);
	});
});
