import { describe, it, expect } from 'vitest';
import { describePage } from './pagination';

describe('describePage', () => {
	it('shows the range of a middle page', () => {
		expect(describePage({ page: 2, limit: 20, total: 55, totalPages: 3 })).toEqual({ from: 21, to: 40, hasPrev: true, hasNext: true });
	});

	it('ends the last page at the total', () => {
		expect(describePage({ page: 3, limit: 20, total: 55, totalPages: 3 })).toEqual({ from: 41, to: 55, hasPrev: true, hasNext: false });
	});

	it('has no range or navigation for an empty result', () => {
		expect(describePage({ page: 1, limit: 20, total: 0, totalPages: 0 })).toEqual({ from: 0, to: 0, hasPrev: false, hasNext: false });
	});
});
