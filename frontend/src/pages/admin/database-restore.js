import api from '../../services/api';
import { RESTORE_CONFIRMATION } from '@sab/shared';

// Same cap as the backend upload limit (multer) and the nginx location.
const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;
const FORMAT_VERSION = 2;
const LONG_REQUEST_TIMEOUT_MS = 120000;

export const RESTORE_PHRASE = RESTORE_CONFIRMATION;

const SECTION_LABELS = {
	products: 'sản phẩm',
	combos: 'combo',
	orders: 'đơn hàng',
	stockMovements: 'dòng lịch sử tồn kho',
	settings: 'bản cài đặt'
};

const SKIP_REASON_LABELS = {
	id_exists: 'đã có cùng mã',
	name_exists: 'đã có cùng tên',
	order_code_exists: 'đã có cùng mã đơn'
};

const pad = (n) => String(n).padStart(2, '0');

/** `pre-restore-YYYYMMDD-HHmmss.json` in the browser's local time. */
export function preRestoreFilename(now = new Date()) {
	const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `pre-restore-${date}-${time}.json`;
}

/** The Restore button is enabled only when every step before it is done. */
export function canRestore({ file, fileProblem, backupSaved, phrase, busy }) {
	return Boolean(file) && !fileProblem && backupSaved && phrase === RESTORE_PHRASE && !busy;
}

/** "7 sản phẩm, 5 combo, ..." for the counts of a restore response or a file's metadata. */
export function describeCounts(counts) {
	return Object.entries(SECTION_LABELS)
		.filter(([section]) => Number.isInteger(counts?.[section]))
		.map(([section, label]) => `${counts[section]} ${label}`)
		.join(', ');
}

/**
 * Read a chosen file and say whether Restore can use it. The server checks
 * everything again; this only spares the admin the backup download and a
 * round trip for a file that cannot work.
 *
 * @returns {Promise<{problem: string|null, counts: object|null}>}
 */
export async function inspectBackupFile(file) {
	if (file.size > MAX_BACKUP_FILE_BYTES) {
		return { problem: `File lớn hơn giới hạn ${MAX_BACKUP_FILE_BYTES / (1024 * 1024)}MB`, counts: null };
	}
	let parsed;
	try {
		parsed = JSON.parse(await file.text());
	} catch {
		return { problem: 'File không phải JSON hợp lệ', counts: null };
	}
	const formatVersion = parsed?.metadata?.formatVersion;
	if (formatVersion === undefined) {
		return { problem: 'Đây là file xuất theo định dạng cũ, không khôi phục được. Hãy dùng "Nhập Database" để gộp dữ liệu.', counts: null };
	}
	if (formatVersion !== FORMAT_VERSION) {
		return { problem: `Phiên bản định dạng ${formatVersion} không được hỗ trợ.`, counts: null };
	}
	return { problem: null, counts: parsed.metadata.collections || null };
}

function saveBlob(blob, filename) {
	const url = window.URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	window.URL.revokeObjectURL(url);
}

/** A readable message from an axios error, including one inside a blob body. */
async function readRequestError(error, fallback) {
	let data = error?.response?.data;
	if (data instanceof Blob) {
		try {
			data = JSON.parse(await data.text());
		} catch {
			data = null;
		}
	}
	return {
		message: data?.message || data?.error || (error?.code === 'ECONNABORTED' ? 'Quá thời gian chờ, vui lòng thử lại' : fallback),
		problems: Array.isArray(data?.problems) ? data.problems : [],
		correlationId: data?.correlationId
	};
}

/**
 * Download a fresh export of the current data as the safety copy taken before a
 * restore. Resolves only once the response is a usable v2 backup and the
 * download has been started, so the Restore step stays locked on any failure.
 *
 * @returns {Promise<string>} the filename offered to the browser
 */
export async function downloadPreRestoreBackup(now = new Date()) {
	let response;
	try {
		response = await api.get('/admin/database/export', { responseType: 'blob', timeout: LONG_REQUEST_TIMEOUT_MS });
	} catch (error) {
		throw new Error((await readRequestError(error, 'Không tải được bản sao lưu hiện tại')).message);
	}
	const blob = new Blob([response.data], { type: 'application/json' });
	let metadata;
	try {
		metadata = JSON.parse(await blob.text()).metadata;
	} catch {
		metadata = null;
	}
	if (!blob.size || metadata?.formatVersion !== FORMAT_VERSION) {
		throw new Error('Bản sao lưu hiện tại tải về không hợp lệ');
	}
	const filename = preRestoreFilename(now);
	saveBlob(blob, filename);
	return filename;
}

/**
 * Send the restore request.
 *
 * @returns {Promise<object>} the server's `{ ok, restored, message }`
 * @throws {Error & {problems: string[]}}
 */
export async function restoreFromFile(file, phrase) {
	const form = new FormData();
	form.append('confirmation', phrase);
	form.append('dataFile', file);
	try {
		const response = await api.post('/admin/database/restore', form, {
			headers: { 'Content-Type': 'multipart/form-data' },
			timeout: LONG_REQUEST_TIMEOUT_MS
		});
		return response.data;
	} catch (error) {
		const { message, problems } = await readRequestError(error, 'Lỗi khi khôi phục database');
		throw Object.assign(new Error(message), { problems });
	}
}

/** Per-collection lines for the merge import summary, with the reasons for every skip. */
export function describeImportResults(response) {
	const lines = Object.entries(response.results || {}).map(([collection, result]) => {
		const reasons = Object.entries(result.skippedByReason || {})
			.map(([reason, count]) => `${count} ${SKIP_REASON_LABELS[reason] || reason}`)
			.join(', ');
		return {
			collection,
			imported: result.imported,
			skipped: result.skipped,
			errors: result.errors,
			skippedText: result.skipped > 0 && reasons ? `bỏ qua ${result.skipped} (${reasons})` : ''
		};
	});
	const ignored = Object.entries(response.ignored || {}).map(([section, info]) => `${section}: ${info.count} bản ghi không được gộp. ${info.reason}`);
	const dropped = Object.entries(response.droppedFields || {})
		.filter(([, fields]) => Object.keys(fields).length > 0)
		.map(([collection, fields]) => `${collection}: ${Object.entries(fields).map(([field, count]) => `${field} (${count})`).join(', ')}`);
	return { lines, ignored, dropped };
}

export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
