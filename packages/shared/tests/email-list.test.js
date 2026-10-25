import { describe, it, expect } from 'vitest';
import { parseEmailList, normalizeEmail } from '../src/index.js';

describe('normalizeEmail', () => {
	it('trims and lowercases', () => {
		expect(normalizeEmail('  A@B.Com ')).toBe('a@b.com');
	});
});

describe('parseEmailList', () => {
	it('splits on newlines, commas, semicolons, tabs and spaces', () => {
		const { emails, invalid, duplicates } = parseEmailList('a@x.vn,b@x.vn;c@x.vn\r\nd@x.vn\te@x.vn f@x.vn');
		expect(emails).toEqual(['a@x.vn', 'b@x.vn', 'c@x.vn', 'd@x.vn', 'e@x.vn', 'f@x.vn']);
		expect(invalid).toEqual([]);
		expect(duplicates).toBe(0);
	});

	it('drops the header of a column pasted from Excel', () => {
		expect(parseEmailList('Email\r\na@x.vn\r\nb@x.vn\r\n').emails).toEqual(['a@x.vn', 'b@x.vn']);
		expect(parseEmailList('"EMAIL"\na@x.vn').emails).toEqual(['a@x.vn']);
	});

	it('unwraps Name <email> in quoted and bare forms, names with spaces included', () => {
		const text = '"Nguyen Van A" <A@x.vn>, Tran Thi B <b@x.vn>; <c@x.vn>\n"Le, C" <d@x.vn>';
		const { emails, invalid } = parseEmailList(text);
		expect(emails).toEqual(['a@x.vn', 'b@x.vn', 'c@x.vn', 'd@x.vn']);
		expect(invalid).toEqual([]);
	});

	it('lowercases and counts duplicates, keeping first order', () => {
		const { emails, duplicates } = parseEmailList('B@x.vn\na@x.vn\nb@X.vn\nA@x.vn\nc@x.vn');
		expect(emails).toEqual(['b@x.vn', 'a@x.vn', 'c@x.vn']);
		expect(duplicates).toBe(2);
	});

	it('reports invalid tokens once and keeps the valid ones', () => {
		const { emails, invalid } = parseEmailList('a@x.vn nope @x.vn a@ nope a@b,c');
		expect(emails).toEqual(['a@x.vn']);
		expect(invalid).toEqual(['nope', '@x.vn', 'a@', 'a@b', 'c']);
	});

	it('handles empty and non-string input', () => {
		for (const input of ['', '  \n ', null, undefined, 5]) {
			expect(parseEmailList(input)).toEqual({ emails: [], invalid: [], duplicates: 0 });
		}
	});

	it('parses 5000 lines quickly', () => {
		const lines = Array.from({ length: 5000 }, (_, i) => `user${i}@school.edu.vn`);
		lines.push('USER0@school.edu.vn');
		const started = performance.now();
		const { emails, duplicates } = parseEmailList(['Email', ...lines].join('\r\n'));
		expect(emails).toHaveLength(5000);
		expect(duplicates).toBe(1);
		expect(performance.now() - started).toBeLessThan(2000);
	});
});
