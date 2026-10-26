import { describe, it, expect } from 'vitest';
import { googleClientId, GOOGLE_CLIENT_ID_MAX_LENGTH } from '../src/index.js';

describe('googleClientId', () => {
	it('accepts and trims a Web client id', () => {
		expect(googleClientId.safeParse(' 1234-abc.apps.googleusercontent.com ')).toMatchObject({
			success: true,
			data: '1234-abc.apps.googleusercontent.com'
		});
	});

	it('accepts an empty or blank value as "Google off"', () => {
		expect(googleClientId.safeParse('  ')).toMatchObject({ success: true, data: '' });
	});

	it.each([
		'1234-abc',
		'1234.apps.googleusercontent.com.evil.example',
		'a b.apps.googleusercontent.com',
		'GOCSPX-secret',
		`${'a'.repeat(GOOGLE_CLIENT_ID_MAX_LENGTH)}.apps.googleusercontent.com`,
		null,
		42
	])('rejects %s', (value) => {
		expect(googleClientId.safeParse(value).success).toBe(false);
	});
});
