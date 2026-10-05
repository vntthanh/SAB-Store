import { z } from '../z.js';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, isCommonPassword } from '../password-rules.js';

// A password is a credential: every schema here validates the value exactly as
// sent, never trimmed. Trimming would let the stored credential differ from what
// the user typed, and a password made of spaces would pass as "present".

const REQUIRED = 'Mật khẩu là bắt buộc';
const TOO_COMMON = 'Mật khẩu này quá phổ biến và không an toàn';

/** Login: any non-empty value; strength rules must not lock out an existing account. */
export const loginPassword = z.string({ error: REQUIRED }).min(1, REQUIRED);

/**
 * Password chosen for a new account: Better Auth's own bounds plus the
 * blocklist, no letter-case rules.
 */
export const sellerPassword = z
	.string({ error: REQUIRED })
	.min(1, REQUIRED)
	.min(MIN_PASSWORD_LENGTH, `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự`)
	.max(MAX_PASSWORD_LENGTH, `Mật khẩu không được vượt quá ${MAX_PASSWORD_LENGTH} ký tự`)
	.refine((value) => !isCommonPassword(value), TOO_COMMON);

const LENGTH_RANGE = `Mật khẩu phải có từ ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} ký tự`;

/** A new password the user picks for an existing account: the full strength policy. */
export const newPassword = z
	.string({ error: REQUIRED })
	.min(1, REQUIRED)
	.min(MIN_PASSWORD_LENGTH, LENGTH_RANGE)
	.max(MAX_PASSWORD_LENGTH, LENGTH_RANGE)
	.regex(/[a-z]/, 'Mật khẩu phải chứa ít nhất 1 chữ cái thường')
	.regex(/[A-Z]/, 'Mật khẩu phải chứa ít nhất 1 chữ cái hoa')
	.refine((value) => !isCommonPassword(value), TOO_COMMON);

const CURRENT_REQUIRED = 'Mật khẩu hiện tại là bắt buộc';

export const passwordChange = z.object({
	currentPassword: z.string({ error: CURRENT_REQUIRED }).min(1, CURRENT_REQUIRED),
	newPassword,
});
