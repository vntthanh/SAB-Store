import { describe, it, expect } from 'vitest';
import {
	authErrorMessage,
	canUseAdmin,
	canUseSeller,
	hasRole,
	isEmailIdentifier,
	landingPath,
	parseRoles,
	passwordSignInRequest,
	sanitizeNextPath,
} from './auth-flow';

describe('sanitizeNextPath', () => {
	it('keeps same-origin paths, query included', () => {
		expect(sanitizeNextPath('/s/private-shop')).toBe('/s/private-shop');
		expect(sanitizeNextPath('/order-tracking?code=ABC12')).toBe('/order-tracking?code=ABC12');
	});

	it.each([
		'https://evil.example',
		'//evil.example',
		'/\\evil.example',
		'/ok\\..\\evil',
		'javascript:alert(1)',
		'evil.example/path',
		'/a\nb',
		'',
		'   ',
	])('rejects %j', (value) => {
		expect(sanitizeNextPath(value)).toBeNull();
	});

	it('rejects non-strings and the login page itself', () => {
		expect(sanitizeNextPath(undefined)).toBeNull();
		expect(sanitizeNextPath(['/x'])).toBeNull();
		expect(sanitizeNextPath('/login')).toBeNull();
		expect(sanitizeNextPath('/login?next=/x')).toBeNull();
	});

	it('rejects absurdly long values', () => {
		expect(sanitizeNextPath(`/${'a'.repeat(600)}`)).toBeNull();
	});
});

describe('roles', () => {
	it('splits a comma list', () => {
		expect(parseRoles('admin, seller')).toEqual(['admin', 'seller']);
		expect(parseRoles(undefined)).toEqual([]);
	});

	it('does not match a role by substring', () => {
		expect(hasRole({ role: 'superadmin' }, 'admin')).toBe(false);
		expect(hasRole({ role: 'seller,admin' }, 'admin')).toBe(true);
	});

	it('lets admin into the seller area but not seller into admin', () => {
		expect(canUseSeller({ role: 'admin' })).toBe(true);
		expect(canUseAdmin({ role: 'seller' })).toBe(false);
		expect(canUseSeller({ role: 'customer' })).toBe(false);
	});
});

describe('landingPath', () => {
	it('sends staff to their dashboard without a next', () => {
		expect(landingPath({ user: { role: 'admin' } })).toBe('/admin/dashboard');
		expect(landingPath({ user: { role: 'seller' } })).toBe('/seller/dashboard');
	});

	it('keeps a staff deep link, but never sends a seller to /admin', () => {
		expect(landingPath({ user: { role: 'admin' }, next: '/admin/settings' })).toBe('/admin/settings');
		expect(landingPath({ user: { role: 'seller' }, next: '/admin/settings' })).toBe('/seller/dashboard');
		expect(landingPath({ user: { role: 'seller' }, next: '/seller/direct-sales' })).toBe('/seller/direct-sales');
	});

	it('sends a customer to next or the shop, ignoring an external next', () => {
		expect(landingPath({ user: { role: 'customer' }, next: '/s/club' })).toBe('/s/club');
		expect(landingPath({ user: { role: 'customer' }, next: 'https://evil.example' })).toBe('/');
		expect(landingPath({ user: { role: 'customer' } })).toBe('/');
	});

	it('never sends a customer into the staff areas', () => {
		expect(landingPath({ user: { role: 'customer' }, next: '/admin/dashboard' })).toBe('/');
		expect(landingPath({ user: { role: 'customer' }, next: '/seller/direct-sales?x=1' })).toBe('/');
		expect(landingPath({ user: { role: 'customer' }, next: '/administrator' })).toBe('/administrator');
	});
});

describe('staff identifier routing', () => {
	it('treats an @ as an email', () => {
		expect(isEmailIdentifier('Staff@Example.com')).toBe(true);
		expect(isEmailIdentifier('staff01')).toBe(false);
	});

	it('signs in by email with a normalised address, else by username', () => {
		expect(passwordSignInRequest({ identifier: '  Staff@Example.com ', password: 'pw' })).toEqual({
			method: 'email',
			body: { email: 'staff@example.com', password: 'pw' },
		});
		expect(passwordSignInRequest({ identifier: ' staff01 ', password: ' pw ' })).toEqual({
			method: 'username',
			body: { username: 'staff01', password: ' pw ' },
		});
	});
});

describe('authErrorMessage', () => {
	it('maps known codes to Vietnamese', () => {
		expect(authErrorMessage({ code: 'INVALID_OTP' })).toBe('Mã xác thực không đúng');
		expect(authErrorMessage({ code: 'INVALID_EMAIL_OR_PASSWORD' })).toMatch(/không chính xác/);
	});

	it('shows a backend message that is already Vietnamese, hides an English one', () => {
		expect(authErrorMessage({ code: 'X', message: 'Email chưa được xác minh, liên hệ admin' })).toMatch(/liên hệ admin/);
		expect(authErrorMessage({ code: 'X', message: 'Something broke' }, 'Đăng nhập thất bại')).toBe('Đăng nhập thất bại');
	});

	it('falls back on a rate-limit status without a code', () => {
		expect(authErrorMessage({ status: 429, message: 'Too many requests' })).toMatch(/Quá nhiều/);
	});
});
