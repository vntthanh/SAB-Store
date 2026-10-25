import { EMAIL_LIST_ENTRIES_MAX, parseEmailList } from '@sab/shared';

export const INVALID_PREVIEW_LIMIT = 20;
// Parsing and previewing a larger list freezes the tab; the server chunks are 5000 anyway.
export const IMPORT_EMAILS_MAX = 20000;
export const IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** What the admin sees before saving: counts from the shared parser plus the first invalid tokens. */
export const buildImportPreview = (text) => {
	const { emails, invalid, duplicates } = parseEmailList(text);
	return {
		emails,
		validCount: emails.length,
		duplicateCount: duplicates,
		invalidCount: invalid.length,
		invalidSample: invalid.slice(0, INVALID_PREVIEW_LIMIT),
		tooMany: emails.length > IMPORT_EMAILS_MAX
	};
};

export const chunkEmails = (emails, size = EMAIL_LIST_ENTRIES_MAX) => {
	const chunks = [];
	for (let from = 0; from < emails.length; from += size) chunks.push(emails.slice(from, from + size));
	return chunks;
};

export const importToastMessage = ({ added, skipped }) => `Đã thêm ${added}, bỏ qua ${skipped} (đã có)`;
