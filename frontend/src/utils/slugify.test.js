import { describe, it, expect } from 'vitest';
import { storefrontSlug } from '@sab/shared';
import { slugify } from './slugify';

describe('slugify', () => {
	it('turns Vietnamese names into ascii slugs, including đ', () => {
		expect(slugify('Gian hàng Đại học Bách Khoa')).toBe('gian-hang-dai-hoc-bach-khoa');
		expect(slugify('Ưu đãi Tết')).toBe('uu-dai-tet');
	});

	it('collapses punctuation and trims separators', () => {
		expect(slugify('  --Hello,   World!!  ')).toBe('hello-world');
		expect(slugify('A & B / C')).toBe('a-b-c');
	});

	it('returns an empty string when nothing usable remains', () => {
		expect(slugify('')).toBe('');
		expect(slugify('!!!')).toBe('');
		expect(slugify(null)).toBe('');
	});

	it('caps the length at 60 without a trailing hyphen', () => {
		const slug = slugify(`${'a'.repeat(59)} bbb`);
		expect(slug.length).toBeLessThanOrEqual(60);
		expect(slug.endsWith('-')).toBe(false);
	});

	it('produces values the shared slug schema accepts', () => {
		expect(storefrontSlug.safeParse(slugify('Gian hàng Sinh viên 2026')).success).toBe(true);
	});
});
