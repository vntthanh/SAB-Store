const {
	asString,
	asEnum,
	asSort,
	asPageLimit,
	asDate,
	escapeRegExp,
	safeSearch,
} = require('../../utils/query-guard');

describe('query-guard', () => {
	describe('asString', () => {
		it('passes a string through and caps its length', () => {
			expect(asString('hello')).toBe('hello');
			expect(asString('x'.repeat(200), 10)).toHaveLength(10);
		});

		it('rejects the operator objects express can produce from a query string', () => {
			expect(asString({ $ne: null })).toBeUndefined();
			expect(asString(['a', 'b'])).toBeUndefined();
			expect(asString(undefined)).toBeUndefined();
		});
	});

	describe('asEnum', () => {
		it('keeps allowed values and drops everything else', () => {
			expect(asEnum('paid', ['paid', 'cancelled'])).toBe('paid');
			expect(asEnum('deleted', ['paid', 'cancelled'])).toBeUndefined();
			expect(asEnum({ $ne: 'paid' }, ['paid'])).toBeUndefined();
		});
	});

	describe('asSort', () => {
		const allowed = ['createdAt', 'totalAmount'];

		it('sorts by an allowed field in the requested direction', () => {
			expect(asSort('totalAmount', 'asc', allowed)).toEqual({ totalAmount: 1 });
			expect(asSort('totalAmount', 'desc', allowed)).toEqual({ totalAmount: -1 });
		});

		it('falls back to a known field rather than sorting by attacker input', () => {
			expect(asSort('password', 'asc', allowed)).toEqual({ createdAt: 1 });
		});
	});

	describe('asPageLimit', () => {
		it('clamps to sane bounds', () => {
			expect(asPageLimit('2', '50')).toEqual({ page: 2, limit: 50 });
			// A negative limit clamps up to 1; an oversized one clamps down to maxLimit.
			expect(asPageLimit('-5', '9999')).toEqual({ page: 1, limit: 100 });
			expect(asPageLimit('1', '-3')).toEqual({ page: 1, limit: 1 });
		});

		it('treats a zero page or limit as absent and uses the default', () => {
			// parseInt('0') is falsy, so 0 takes the default rather than
			// producing an empty page.
			expect(asPageLimit('0', '0')).toEqual({ page: 1, limit: 20 });
		});

		it('defaults when the input is not numeric', () => {
			expect(asPageLimit(undefined, undefined)).toEqual({ page: 1, limit: 20 });
			expect(asPageLimit('abc', 'abc')).toEqual({ page: 1, limit: 20 });
		});
	});

	describe('asDate', () => {
		it('parses a valid date and rejects junk', () => {
			expect(asDate('2026-09-14')).toBeInstanceOf(Date);
			expect(asDate('not-a-date')).toBeUndefined();
			expect(asDate({ $gt: '2020-01-01' })).toBeUndefined();
		});
	});

	describe('safeSearch', () => {
		it('escapes regex metacharacters so the pattern matches literally', () => {
			expect(escapeRegExp('a.*b')).toBe('a\\.\\*b');
			expect(safeSearch('a.*b')).toEqual({ $regex: 'a\\.\\*b', $options: 'i' });
		});

		it('drops non-string input instead of building a matcher', () => {
			expect(safeSearch({ $ne: null })).toBeUndefined();
		});
	});
});
