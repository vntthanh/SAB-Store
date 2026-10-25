import { IMPORT_FILE_MAX_BYTES } from '../utils/email-import';

const TEXT_EXTENSIONS = ['.csv', '.txt'];
const XLSX_EXTENSION = '.xlsx';
const MAX_MB = IMPORT_FILE_MAX_BYTES / (1024 * 1024);

export const EMAIL_FILE_ACCEPT = '.csv,.txt,.xlsx';

const extensionOf = (name) => {
	const dot = String(name).lastIndexOf('.');
	return dot === -1 ? '' : String(name).slice(dot).toLowerCase();
};

// exceljs is large and only the import dialog needs it, so it loads on first .xlsx upload.
async function readWorkbookText(file) {
	const mod = await import('exceljs');
	const ExcelJS = mod.default ?? mod;
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(await file.arrayBuffer());

	// Every cell of every sheet: the address column is not known, and the parser keeps only valid emails.
	const cells = [];
	workbook.eachSheet((sheet) => {
		sheet.eachRow((row) => {
			row.eachCell({ includeEmpty: false }, (cell) => {
				const text = cell.text;
				if (text) cells.push(text);
			});
		});
	});
	return cells.join('\n');
}

/**
 * The text of an uploaded .csv/.txt/.xlsx for parseEmailList.
 * @throws {Error} with a Vietnamese message the dialog shows as is
 */
export async function readEmailFile(file) {
	const extension = extensionOf(file.name);

	if (extension === '.xls') {
		throw new Error('Không hỗ trợ file .xls cũ. Hãy lưu lại thành .xlsx hoặc .csv rồi tải lên.');
	}
	if (!TEXT_EXTENSIONS.includes(extension) && extension !== XLSX_EXTENSION) {
		throw new Error('Chỉ hỗ trợ file .csv, .txt hoặc .xlsx.');
	}
	if (file.size > IMPORT_FILE_MAX_BYTES) {
		throw new Error(`File quá lớn (tối đa ${MAX_MB} MB).`);
	}

	if (extension === XLSX_EXTENSION) {
		try {
			return await readWorkbookText(file);
		} catch {
			throw new Error('Không đọc được file .xlsx. Hãy kiểm tra file có bị hỏng hoặc đặt mật khẩu không.');
		}
	}
	return file.text();
}
