import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseEmailList } from '@sab/shared';
import { readEmailFile } from './read-email-file';

const xlsxFile = async (rows, name = 'emails.xlsx') => {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Sheet1');
	rows.forEach((row) => sheet.addRow(row));
	return new File([await workbook.xlsx.writeBuffer()], name);
};

describe('readEmailFile', () => {
	it('reads CSV and TXT as text', async () => {
		const csv = new File(['email,name\na@x.com,A\nb@x.com,B'], 'list.csv');
		expect(parseEmailList(await readEmailFile(csv)).emails).toEqual(['a@x.com', 'b@x.com']);

		const txt = new File(['c@x.com\nd@x.com'], 'list.TXT');
		expect(parseEmailList(await readEmailFile(txt)).emails).toEqual(['c@x.com', 'd@x.com']);
	});

	it('extracts emails from any column and sheet cell of an xlsx', async () => {
		const file = await xlsxFile([
			['Tên', 'Email', 'Ghi chú'],
			['An', 'an@x.com', 'x'],
			['Bình', 'ghi chú', 'binh@x.com']
		]);
		const parsed = parseEmailList(await readEmailFile(file));
		expect(parsed.emails).toEqual(['an@x.com', 'binh@x.com']);
	});

	it('refuses .xls with a message', async () => {
		await expect(readEmailFile(new File(['x'], 'old.xls'))).rejects.toThrow('.xls');
	});

	it('refuses other extensions and oversize files', async () => {
		await expect(readEmailFile(new File(['x'], 'a.pdf'))).rejects.toThrow('.csv');
		const big = { name: 'big.csv', size: 6 * 1024 * 1024, text: async () => '' };
		await expect(readEmailFile(big)).rejects.toThrow('tối đa 5 MB');
	});

	it('reports a corrupt xlsx instead of leaking the parser error', async () => {
		await expect(readEmailFile(new File(['not a zip'], 'broken.xlsx'))).rejects.toThrow('Không đọc được file .xlsx');
	});
});
