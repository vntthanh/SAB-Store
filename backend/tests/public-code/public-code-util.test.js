const publicCode = require('../../utils/public-code');
const Product = require('../../models/Product');
const { makeProduct } = require('../helpers/factories');

const {
	PUBLIC_CODE_PATTERN,
	generatePublicCode,
	normalizePublicCode,
	makeSlug,
	withPublicCodeRetry,
	createWithPublicCodeRetry
} = publicCode;

beforeAll(() => Product.init());
afterEach(() => jest.restoreAllMocks());

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

describe('createWithPublicCodeRetry', () => {
	const COLLIDING = 'AAAAAAAA';

	it('draws a new code when the first one collides', async () => {
		await makeProduct({ publicCode: COLLIDING });
		const spy = jest.spyOn(publicCode, 'generatePublicCode').mockReturnValueOnce(COLLIDING);

		const created = await createWithPublicCodeRetry(Product, { name: 'Retry me', price: 1000, category: 'general' });

		expect(spy).toHaveBeenCalledTimes(2);
		expect(created.publicCode).not.toBe(COLLIDING);
		expect(created.publicCode).toMatch(PUBLIC_CODE_PATTERN);
	});

	it('gives up after 5 collisions and rethrows the duplicate-key error', async () => {
		await makeProduct({ publicCode: COLLIDING });
		const spy = jest.spyOn(publicCode, 'generatePublicCode').mockReturnValue(COLLIDING);

		await expect(createWithPublicCodeRetry(Product, { name: 'Never', price: 1000, category: 'general' }))
			.rejects.toMatchObject({ code: 11000 });
		expect(spy).toHaveBeenCalledTimes(5);
		expect(await Product.countDocuments({})).toBe(1);
	});

	it('tries a caller-supplied code once: redrawing cannot fix a fixed code', async () => {
		await makeProduct({ publicCode: COLLIDING });
		const spy = jest.spyOn(publicCode, 'generatePublicCode');

		await expect(createWithPublicCodeRetry(Product, { name: 'Restore', price: 1000, category: 'general', publicCode: COLLIDING }))
			.rejects.toMatchObject({ code: 11000 });
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('withPublicCodeRetry', () => {
	it('does not retry an E11000 on another field', async () => {
		const error = Object.assign(new Error('dup sku'), { code: 11000, keyPattern: { sku: 1 } });
		const fn = jest.fn().mockRejectedValue(error);

		await expect(withPublicCodeRetry(fn)).rejects.toBe(error);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
