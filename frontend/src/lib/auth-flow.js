import { normalizeEmail } from '@sab/shared';

export const OTP_RESEND_SECONDS = 60;
// Mirrors the server's code lifetime so the hint under the code field is not a guess.
export const OTP_EXPIRES_MINUTES = 5;

/**
 * The `next` query value when it is a path on this site, else null. A leading
 * "//" or "/\" is a protocol-relative URL that browsers resolve to another host,
 * and control characters can smuggle one past the prefix check.
 */
export const sanitizeNextPath = (raw) => {
	if (typeof raw !== 'string') return null;
	const value = raw.trim();
	if (value.length === 0 || value.length > 512) return null;
	if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
	// Landing back on the login page after signing in would just show it again.
	if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login/')) return null;
	return value;
};

/** Better Auth stores several roles as one comma-separated string. */
export const parseRoles = (role) =>
	String(role ?? '')
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);

export const hasRole = (user, role) => parseRoles(user?.role).includes(role);

export const canUseAdmin = (user) => hasRole(user, 'admin');
export const canUseSeller = (user) => hasRole(user, 'admin') || hasRole(user, 'seller');

const isStaffArea = (path, area) => path === area || path.startsWith(`${area}/`) || path.startsWith(`${area}?`);

/**
 * Where /login sends a signed-in user. A staff `next` is honoured so a deep link
 * to an admin page survives the sign-in, but a path the role cannot open is
 * dropped: its route guard would bounce the user back to /login and loop.
 */
export const landingPath = ({ user, next }) => {
	const safe = sanitizeNextPath(next);
	if (canUseAdmin(user)) return safe ?? '/admin/dashboard';
	if (hasRole(user, 'seller')) return safe && !isStaffArea(safe, '/admin') ? safe : '/seller/dashboard';
	return safe && !isStaffArea(safe, '/admin') && !isStaffArea(safe, '/seller') ? safe : '/';
};

/** An "@" means an email; usernames cannot contain one. */
export const isEmailIdentifier = (identifier) => String(identifier ?? '').includes('@');

/** The Better Auth call and credentials for the staff password form. */
export const passwordSignInRequest = ({ identifier, password }) => {
	const trimmed = String(identifier ?? '').trim();
	return isEmailIdentifier(trimmed)
		? { method: 'email', body: { email: normalizeEmail(trimmed), password } }
		: { method: 'username', body: { username: trimmed, password } };
};

const KNOWN_MESSAGES = {
	INVALID_EMAIL_OR_PASSWORD: 'Tên đăng nhập hoặc mật khẩu không chính xác',
	INVALID_USERNAME_OR_PASSWORD: 'Tên đăng nhập hoặc mật khẩu không chính xác',
	INVALID_PASSWORD: 'Tên đăng nhập hoặc mật khẩu không chính xác',
	USER_NOT_FOUND: 'Tên đăng nhập hoặc mật khẩu không chính xác',
	INVALID_CREDENTIALS: 'Tên đăng nhập hoặc mật khẩu không chính xác',
	INVALID_OTP: 'Mã xác thực không đúng',
	OTP_EXPIRED: 'Mã xác thực đã hết hạn, vui lòng gửi lại mã',
	TOO_MANY_ATTEMPTS: 'Nhập sai quá nhiều lần, vui lòng gửi lại mã mới',
	OTP_COOLDOWN: 'Vui lòng chờ một lúc trước khi gửi lại mã',
	OTP_LIMIT_REACHED: 'Đã gửi quá nhiều mã, vui lòng thử lại sau',
	OTP_MAIL_UNAVAILABLE: 'Hiện chưa gửi được email, vui lòng thử lại sau',
	INVALID_EMAIL: 'Email không hợp lệ',
	TOO_MANY_REQUESTS: 'Quá nhiều yêu cầu, vui lòng thử lại sau',
};

// Anything with a non-ASCII letter came from the backend's own Vietnamese copy;
// Better Auth's built-in messages are English and would read badly on this form.
const looksLocalised = (message) => /[^\u0000-\u007f]/.test(message);

/** A Vietnamese message for a Better Auth `{ code, message, status }` error. */
export const authErrorMessage = (error, fallback = 'Đăng nhập thất bại') => {
	if (!error) return fallback;
	if (error.code && KNOWN_MESSAGES[error.code]) return KNOWN_MESSAGES[error.code];
	if (error.status === 429) return KNOWN_MESSAGES.TOO_MANY_REQUESTS;
	if (typeof error.message === 'string' && error.message && looksLocalised(error.message)) return error.message;
	return fallback;
};
