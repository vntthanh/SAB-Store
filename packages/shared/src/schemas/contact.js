import { z } from '../z.js';

// Store contact details shown in the public footer. Both are optional: an empty
// string hides that line.
export const CONTACT_EMAIL_MAX_LENGTH = 254;
export const CONTACT_URL_MAX_LENGTH = 500;

const EMAIL_MESSAGE = 'Email liên hệ không hợp lệ';
const URL_MESSAGE = 'Liên kết phải là địa chỉ http:// hoặc https:// hợp lệ';

const isEmail = (value) => z.email().safeParse(value).success;

// The value is rendered as a link's href, so only http(s) is accepted: a
// `javascript:` URL would run script for every visitor who clicks it.
const isWebUrl = (value) => {
	try {
		const { protocol } = new URL(value);
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
};

export const contactEmail = z
	.string({ error: EMAIL_MESSAGE })
	.trim()
	.max(CONTACT_EMAIL_MAX_LENGTH, EMAIL_MESSAGE)
	.refine((value) => value === '' || isEmail(value), EMAIL_MESSAGE);

export const contactUrl = z
	.string({ error: URL_MESSAGE })
	.trim()
	.max(CONTACT_URL_MAX_LENGTH, URL_MESSAGE)
	.refine((value) => value === '' || isWebUrl(value), URL_MESSAGE);
