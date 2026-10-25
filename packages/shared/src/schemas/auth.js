import { z } from '../z.js';
import { loginPassword } from './password.js';
import { emailAddress } from './storefront.js';

const OTP_MESSAGE = 'Mã xác thực gồm đúng 6 chữ số';
const IDENTIFIER_MAX = 254;
const IDENTIFIER_MESSAGE = `Tên đăng nhập hoặc email phải từ 1 đến ${IDENTIFIER_MAX} ký tự`;

export const otpRequest = z.object({ email: emailAddress });

export const otpVerify = z.object({
	email: emailAddress,
	otp: z.string({ error: OTP_MESSAGE }).regex(/^\d{6}$/, OTP_MESSAGE),
});

// Login must not apply strength rules, or an existing account created under
// older rules could never sign in; the password is validated untrimmed.
export const staffLogin = z.object({
	identifier: z
		.string({ error: IDENTIFIER_MESSAGE })
		.trim()
		.min(1, IDENTIFIER_MESSAGE)
		.max(IDENTIFIER_MAX, IDENTIFIER_MESSAGE),
	password: loginPassword.max(256, 'Mật khẩu không được vượt quá 256 ký tự'),
});
