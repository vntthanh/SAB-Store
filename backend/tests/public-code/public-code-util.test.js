const publicCode = require('../../utils/public-code');

const {
	PUBLIC_CODE_PATTERN,
	generatePublicCode,
	normalizePublicCode,
	makeSlug,
	withPublicCodeRetry
} = publicCode;

afterEach(() => vi.restoreAllMocks());

describe('generatePublicCode', () => {
	it('always yields 8 characters from the unambiguous alphabet', () => {
		for (let i = 0; i < 10000; i++) {
			const code = generatePublicCode();
			if (!PUBLIC_CODE_PATTERN.test(code) || /[01OIL]/.test(code)) {
				throw new Error(`bad code ${code}`);
			}
		}
	});
});

describe('normalizePublicCode', () => {
	it('upper-cases and trims a valid code', () => {
		expect(normalizePublicCode(' ab2c3d4e ')).toBe('AB2C3D4E');
	});

	it('returns null for non-strings and malformed codes without a database call', () => {
		expect(normalizePublicCode({ $ne: null })).toBeNull();
		expect(normalizePublicCode(undefined)).toBeNull();
		expect(normalizePublicCode('AB2C3D4O')).toBeNull();
		expect(normalizePublicCode('SHORT')).toBeNull();
	});
});

describe('makeSlug', () => {
	it('transliterates Vietnamese, including đ', () => {
		expect(makeSlug('Móc khoá SAB — Đỏ', 'ABCDEFGH')).toBe('moc-khoa-sab-do');
	});

	it('falls back to the lower-cased code when nothing survives', () => {
		expect(makeSlug('!!!', 'AB2C3D4E')).toBe('ab2c3d4e');
		expect(makeSlug(undefined, 'AB2C3D4E')).toBe('ab2c3d4e');
	});

	it('cuts to 80 characters without a trailing dash', () => {
		const slug = makeSlug('abcdefg '.repeat(30), 'AB2C3D4E');
		expect(slug.length).toBeLessThanOrEqual(80);
		expect(slug.endsWith('-')).toBe(false);
	});
});

describe('withPublicCodeRetry', () => {
	it('does not retry an E11000 on another field', async () => {
		const error = Object.assign(new Error('dup sku'), { code: 11000, keyPattern: { sku: 1 } });
		const fn = vi.fn().mockRejectedValue(error);

		await expect(withPublicCodeRetry(fn)).rejects.toBe(error);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
