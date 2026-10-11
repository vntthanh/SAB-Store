import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { MAX_PAGE_LIMIT, paginationQuery, toSkipTake, buildPaginationMeta } from '../src/index.js';

const parse = (page, limit) => paginationQuery.parse({ page, limit });

describe('paginationQuery', () => {
	it('defaults to page 1, limit 20 when nothing usable is sent', () => {
		expect(paginationQuery.parse({})).toEqual({ page: 1, limit: 20 });
		expect(parse(undefined, undefined)).toEqual({ page: 1, limit: 20 });
		expect(parse('abc', 'abc')).toEqual({ page: 1, limit: 20 });
		expect(parse('', null)).toEqual({ page: 1, limit: 20 });
		expect(parse('0', '0')).toEqual({ page: 1, limit: 20 });
	});

	it('reads digit strings and numbers', () => {
		expect(parse('2', '50')).toEqual({ page: 2, limit: 50 });
		expect(parse(3, 7)).toEqual({ page: 3, limit: 7 });
	});

	it('clamps instead of rejecting', () => {
		expect(parse('-5', '9999')).toEqual({ page: 1, limit: MAX_PAGE_LIMIT });
		expect(parse('1', '-3')).toEqual({ page: 1, limit: 1 });
		expect(parse('99999999999999999999', '10').page).toBe(1_000_000);
	});

	it('drops operator-shaped query values to the defaults', () => {
		expect(parse({ $gt: '1' }, { $ne: '0' })).toEqual({ page: 1, limit: 20 });
	});

	it('keeps the lenient reading of a trailing-garbage number', () => {
		expect(parse('3abc', '2.9')).toEqual({ page: 3, limit: 2 });
	});

	it('exposes the same schema from the CJS build', () => {
		const cjs = createRequire(import.meta.url)('../dist/index.cjs');
		expect(cjs.MAX_PAGE_LIMIT).toBe(100);
		expect(cjs.paginationQuery.parse({ page: '-5', limit: '9999' })).toEqual({ page: 1, limit: 100 });
		expect(cjs.toSkipTake(3, 10)).toEqual({ skip: 20, take: 10 });
		expect(cjs.buildPaginationMeta(25, { page: 1, limit: 10 }).totalPages).toBe(3);
	});
});

describe('toSkipTake', () => {
	it('turns a page into an offset', () => {
		expect(toSkipTake(1, 20)).toEqual({ skip: 0, take: 20 });
		expect(toSkipTake(3, 10)).toEqual({ skip: 20, take: 10 });
	});
});

describe('buildPaginationMeta', () => {
	it('counts pages, rounding a partial last page up', () => {
		expect(buildPaginationMeta(41, { page: 1, limit: 20 })).toEqual({ page: 1, limit: 20, total: 41, totalPages: 3 });
		expect(buildPaginationMeta(40, { page: 2, limit: 20 }).totalPages).toBe(2);
	});

	it('reports the last page and a page past the end as they are', () => {
		expect(buildPaginationMeta(41, { page: 3, limit: 20 })).toMatchObject({ page: 3, totalPages: 3 });
		expect(buildPaginationMeta(41, { page: 9, limit: 20 })).toMatchObject({ page: 9, totalPages: 3 });
	});

	it('gives an empty result zero pages', () => {
		expect(buildPaginationMeta(0, { page: 1, limit: 20 })).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
	});
});
