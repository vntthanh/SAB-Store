import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import api from '../../services/api';
import {
	RESTORE_PHRASE,
	canRestore,
	describeCounts,
	describeImportResults,
	downloadPreRestoreBackup,
	escapeHtml,
	inspectBackupFile,
	preRestoreFilename,
	restoreFromFile
} from './database-restore';

const jsonFile = (value, name = 'backup.json') => new File([JSON.stringify(value)], name, { type: 'application/json' });
const v2Metadata = { formatVersion: 2, exportedAt: '2026-10-11T00:00:00.000Z', collections: { products: 2, combos: 1, orders: 3, stockMovements: 5, settings: 1 } };

describe('preRestoreFilename', () => {
	it('names the file with pre-restore and the local date and time', () => {
		expect(preRestoreFilename(new Date(2026, 9, 11, 7, 5, 9))).toBe('pre-restore-20261011-070509.json');
	});
});

describe('canRestore', () => {
	const ready = { file: {}, fileProblem: null, backupSaved: true, phrase: RESTORE_PHRASE, busy: false };

	it('is true only when file, backup and exact phrase are all there and nothing is running', () => {
		expect(canRestore(ready)).toBe(true);
	});

	it.each([
		['no file', { file: null }],
		['a file problem', { fileProblem: 'sai định dạng' }],
		['no saved backup', { backupSaved: false }],
		['a lower-case phrase', { phrase: RESTORE_PHRASE.toLowerCase() }],
		['a padded phrase', { phrase: ` ${RESTORE_PHRASE}` }],
		['a running request', { busy: true }]
	])('is false with %s', (_label, change) => {
		expect(canRestore({ ...ready, ...change })).toBe(false);
	});

	it('uses the phrase the backend enforces', () => {
		expect(RESTORE_PHRASE).toBe('KHOI PHUC');
	});
});

describe('describeCounts', () => {
	it('lists the counts in Vietnamese and skips what is not a number', () => {
		expect(describeCounts({ products: 2, combos: 0, orders: 3, stockMovements: 5, settings: 1, extra: 9 }))
			.toBe('2 sản phẩm, 0 combo, 3 đơn hàng, 5 dòng lịch sử tồn kho, 1 bản cài đặt');
		expect(describeCounts(undefined)).toBe('');
	});
});

describe('inspectBackupFile', () => {
	it('accepts a v2 file and returns its counts', async () => {
		expect(await inspectBackupFile(jsonFile({ metadata: v2Metadata, data: {} }))).toEqual({ problem: null, counts: v2Metadata.collections });
	});

	it('sends a v1 file to Import', async () => {
		const { problem } = await inspectBackupFile(jsonFile({ metadata: { version: '2.0' }, data: {} }));
		expect(problem).toContain('Nhập Database');
	});

	it('rejects a newer format version, invalid JSON and an oversized file', async () => {
		expect((await inspectBackupFile(jsonFile({ metadata: { formatVersion: 3 } }))).problem).toContain('3');
		expect((await inspectBackupFile(new File(['{nope'], 'x.json'))).problem).toContain('JSON');
		expect((await inspectBackupFile({ size: 11 * 1024 * 1024 })).problem).toContain('10MB');
	});
});

describe('downloadPreRestoreBackup', () => {
	let link;

	beforeEach(() => {
		link = { click: vi.fn() };
		vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { appendChild: vi.fn(), removeChild: vi.fn() } });
		vi.stubGlobal('window', { URL: { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() } });
		api.get.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('starts the download only for a usable v2 backup and names it pre-restore', async () => {
		api.get.mockResolvedValue({ data: new Blob([JSON.stringify({ metadata: v2Metadata, data: {} })]) });

		const filename = await downloadPreRestoreBackup(new Date(2026, 9, 11, 7, 5, 9));

		expect(filename).toBe('pre-restore-20261011-070509.json');
		expect(link.download).toBe(filename);
		expect(link.click).toHaveBeenCalledTimes(1);
	});

	it('fails without downloading when the response is not a v2 backup', async () => {
		api.get.mockResolvedValue({ data: new Blob([JSON.stringify({ metadata: { version: '2.0' } })]) });

		await expect(downloadPreRestoreBackup()).rejects.toThrow('không hợp lệ');
		expect(link.click).not.toHaveBeenCalled();
	});

	it('fails without downloading when the request fails, with the server message', async () => {
		api.get.mockRejectedValue({ response: { data: new Blob([JSON.stringify({ message: 'Lỗi máy chủ' })]) } });

		await expect(downloadPreRestoreBackup()).rejects.toThrow('Lỗi máy chủ');
		expect(link.click).not.toHaveBeenCalled();
	});
});

describe('restoreFromFile', () => {
	beforeEach(() => {
		api.post.mockReset();
	});

	it('posts the phrase and the file as multipart and returns the server answer', async () => {
		api.post.mockResolvedValue({ data: { ok: true, restored: { products: 1 } } });
		const file = jsonFile({ metadata: v2Metadata });

		const result = await restoreFromFile(file, RESTORE_PHRASE);

		expect(result).toEqual({ ok: true, restored: { products: 1 } });
		const [url, form] = api.post.mock.calls[0];
		expect(url).toBe('/admin/database/restore');
		expect(form.get('confirmation')).toBe(RESTORE_PHRASE);
		expect(form.get('dataFile')).toBeInstanceOf(File);
	});

	it('throws the server message with its problem lines', async () => {
		api.post.mockRejectedValue({ response: { data: { message: 'File sao lưu không hợp lệ', problems: ['products[0].price phải là số nguyên'] } } });

		await expect(restoreFromFile(jsonFile({}), RESTORE_PHRASE)).rejects.toMatchObject({
			message: 'File sao lưu không hợp lệ',
			problems: ['products[0].price phải là số nguyên']
		});
	});
});

describe('describeImportResults', () => {
	it('reports skips with their reasons, ignored sections and dropped fields', () => {
		const summary = describeImportResults({
			results: {
				products: { imported: 1, skipped: 3, errors: 0, skippedByReason: { id_exists: 1, name_exists: 2 } },
				combos: { imported: 2, skipped: 0, errors: 0, skippedByReason: {} }
			},
			ignored: { stockMovements: { count: 8, reason: 'Dùng Khôi phục.' } },
			droppedFields: { products: { slug: 1 }, combos: {} }
		});

		expect(summary.lines[0]).toEqual(expect.objectContaining({ collection: 'products', skippedText: 'bỏ qua 3 (1 đã có cùng mã, 2 đã có cùng tên)' }));
		expect(summary.lines[1].skippedText).toBe('');
		expect(summary.ignored).toEqual(['stockMovements: 8 bản ghi không được gộp. Dùng Khôi phục.']);
		expect(summary.dropped).toEqual(['products: slug (1)']);
	});

	it('copes with an older server answer that has none of the new fields', () => {
		expect(describeImportResults({ results: { orders: { imported: 1, skipped: 0, errors: 0 } } }).dropped).toEqual([]);
	});
});

describe('escapeHtml', () => {
	it('escapes markup so a product name cannot inject into the dialog', () => {
		expect(escapeHtml('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
	});
});
