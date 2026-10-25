import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/api', () => ({
	storefrontAdminService: {},
	emailListService: {},
	settingsService: { getPublicSettings: vi.fn() }
}));

import { moveId, toForm, toPayload, validateStorefrontForm } from './StorefrontManagement';

const SAVED = {
	_id: 'a1',
	slug: 'sinh-vien',
	name: 'Sinh viên',
	description: 'Chỉ cho sinh viên',
	visibility: 'PRIVATE',
	isActive: false
};

describe('toForm / toPayload', () => {
	it('starts a new storefront public, active and blank', () => {
		expect(toForm(null)).toEqual({ name: '', slug: '', description: '', visibility: 'PUBLIC', isActive: true });
	});

	it('round-trips a saved storefront', () => {
		expect(toPayload(toForm(SAVED))).toEqual({
			name: 'Sinh viên',
			slug: 'sinh-vien',
			description: 'Chỉ cho sinh viên',
			visibility: 'PRIVATE',
			isActive: false
		});
	});

	it('trims text and sends a blank description as null so an edit can clear it', () => {
		const payload = toPayload({ ...toForm(null), name: '  A  ', slug: ' a-b ', description: '   ' });
		expect(payload).toMatchObject({ name: 'A', slug: 'a-b', description: null });
	});
});

describe('validateStorefrontForm', () => {
	it('accepts a complete form', () => {
		expect(validateStorefrontForm({ ...toForm(null), name: 'Gian hàng', slug: 'gian-hang' })).toEqual({});
	});

	it('reports the shared schema message per field', () => {
		const errors = validateStorefrontForm({ ...toForm(null), name: '', slug: 'Bad Slug' });
		expect(errors.name).toBe('Tên phải từ 1 đến 80 ký tự');
		expect(errors.slug).toMatch(/^Đường dẫn phải/);
	});
});

describe('moveId', () => {
	it('swaps with the neighbour and refuses to move past an edge', () => {
		expect(moveId(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
		expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
		expect(moveId(['a', 'b', 'c'], 0, -1)).toBeNull();
		expect(moveId(['a', 'b', 'c'], 2, 1)).toBeNull();
	});

	it('does not mutate its input', () => {
		const ids = ['a', 'b'];
		moveId(ids, 0, 1);
		expect(ids).toEqual(['a', 'b']);
	});
});
