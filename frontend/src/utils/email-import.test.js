import { describe, it, expect } from 'vitest';
import { buildImportPreview, chunkEmails, importToastMessage, INVALID_PREVIEW_LIMIT } from './email-import';

describe('buildImportPreview', () => {
	it('counts 3 valid, 1 duplicate and 1 invalid line', () => {
		const preview = buildImportPreview('a@x.com\nb@x.com\nc@x.com\nA@x.com\nnot-an-email');
		expect(preview).toMatchObject({ validCount: 3, duplicateCount: 1, invalidCount: 1, tooMany: false });
		expect(preview.invalidSample).toEqual(['not-an-email']);
	});

	it('shows at most the first 20 invalid tokens', () => {
		const text = Array.from({ length: 30 }, (_, i) => `bad${i}`).join('\n');
		const preview = buildImportPreview(text);
		expect(preview.invalidCount).toBe(30);
		expect(preview.invalidSample).toHaveLength(INVALID_PREVIEW_LIMIT);
	});

	it('flags a list above the client cap', () => {
		const text = Array.from({ length: 20001 }, (_, i) => `u${i}@x.com`).join('\n');
		expect(buildImportPreview(text).tooMany).toBe(true);
	});

	it('is empty for blank text', () => {
		expect(buildImportPreview('')).toMatchObject({ validCount: 0, duplicateCount: 0, invalidCount: 0 });
	});
});

describe('chunkEmails', () => {
	it('splits into chunks of at most the given size', () => {
		const chunks = chunkEmails(Array.from({ length: 12001 }, (_, i) => `u${i}@x.com`));
		expect(chunks.map((chunk) => chunk.length)).toEqual([5000, 5000, 2001]);
		expect(chunkEmails([])).toEqual([]);
	});
});

describe('importToastMessage', () => {
	it('reports the server counts', () => {
		expect(importToastMessage({ added: 3, skipped: 2 })).toBe('Đã thêm 3, bỏ qua 2 (đã có)');
	});
});
