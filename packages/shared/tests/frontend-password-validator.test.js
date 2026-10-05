import { describe, it, expect } from 'vitest';
import { validatePassword } from '../../../frontend/src/utils/passwordValidator.js';
import { COMMON_PASSWORDS } from '../src/index.js';

// Lives here because the frontend has no committed tests and its vitest run is
// not part of the commit hooks; the shared package's tests are.
describe('frontend validatePassword uses the full shared blocklist', () => {
	it('flags blocklist words the client used to miss', () => {
		for (const word of ['Computer', 'Summer', 'Warrior', 'Michelle1']) {
			expect(COMMON_PASSWORDS).toContain(word.toLowerCase());
			const result = validatePassword(word);
			expect(result.requirements.notCommon).toBe(false);
			expect(result.isValid).toBe(false);
			expect(result.errors).toContain('Mật khẩu này quá phổ biến và không an toàn');
		}
	});

	it('still accepts an uncommon strong password', () => {
		expect(validatePassword('Zq9!xK2#mW4$').isValid).toBe(true);
	});
});
