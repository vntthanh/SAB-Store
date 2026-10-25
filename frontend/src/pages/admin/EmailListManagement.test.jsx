import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/api', () => ({
	emailListService: {}
}));

import { deleteListMessage } from './EmailListManagement';

describe('deleteListMessage', () => {
	it('warns how many storefront rules go with the list', () => {
		const message = deleteListMessage({ name: 'K65', entryCount: 10, ruleCount: 2 });
		expect(message).toContain('2 quy tắc');
		expect(message).toContain('K65');
	});

	it('mentions the entry count when no rule uses the list', () => {
		expect(deleteListMessage({ name: 'K65', entryCount: 10, ruleCount: 0 })).toContain('10 email');
	});
});
