import { z } from './z.js';

export const EMAIL_MAX_LENGTH = 254;

export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

const emailFormat = z.email();

/** True for a well-formed address once trimmed and lowercased. */
export const isValidEmail = (value) => {
	const email = normalizeEmail(value);
	return email.length > 0 && email.length <= EMAIL_MAX_LENGTH && emailFormat.safeParse(email).success;
};

// `"Name" <a@b.c>` and `Name With Spaces <a@b.c>` collapse to the bracketed
// address before splitting; otherwise every word of the name would be reported
// as an invalid email. The name part stops at a separator so it cannot swallow
// the previous entry.
const NAMED_ADDRESS = /(?:"[^"]*"|[^,;\r\n\t<>"]*)\s*<([^<>]*)>/g;
const SEPARATORS = /[\s,;]+/;
const HEADER_TOKENS = new Set(['email', 'emails', 'e-mail']);

/**
 * Pulls addresses out of pasted text (a column copied from Excel, a CSV body,
 * a comma list). Pure and synchronous; callers decide what to do with `invalid`.
 * `duplicates` counts repeated valid addresses that were dropped.
 */
export function parseEmailList(text) {
	const emails = [];
	const invalid = [];
	const seenEmails = new Set();
	const seenInvalid = new Set();
	let duplicates = 0;

	if (typeof text !== 'string' || text === '') return { emails, invalid, duplicates };

	const tokens = text
		.replace(NAMED_ADDRESS, ' $1 ')
		.replace(/["'`]/g, ' ')
		.split(SEPARATORS);

	for (const raw of tokens) {
		const token = normalizeEmail(raw);
		if (token === '' || HEADER_TOKENS.has(token)) continue;
		if (isValidEmail(token)) {
			if (seenEmails.has(token)) duplicates += 1;
			else {
				seenEmails.add(token);
				emails.push(token);
			}
		} else if (!seenInvalid.has(token)) {
			seenInvalid.add(token);
			invalid.push(token);
		}
	}
	return { emails, invalid, duplicates };
}
