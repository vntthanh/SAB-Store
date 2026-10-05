// Password rules that do not depend on Zod: the blocklist, the length bounds
// and the strength estimate. The schemas in schemas/password.js and the UI
// strength indicator both read from here, so a rule changes in one place.

// Matches Better Auth minPasswordLength / maxPasswordLength in backend/lib/auth.js.
// A lower bound here would pass validation and then fail inside the auth call.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export const PASSWORD_STRENGTH = {
	WEAK: 'weak',
	MEDIUM: 'medium',
	STRONG: 'strong',
};

// Common passwords (lower case); compared case-insensitively.
export const COMMON_PASSWORDS = [
	'123456', 'password', '123456789', '12345678', '12345', '1234567',
	'password1', '1234567890', 'qwerty', 'abc123', '111111', '123123',
	'password123', '1234', '123321', 'qwerty123', '000000', 'iloveyou',
	'dragon', 'monkey', 'sunshine', 'princess', 'football', 'charlie',
	'aa123456', 'donald', 'password12', 'qwertyuiop', '654321', 'lovely',
	'7777777', '123qwe', 'maggie', 'qwerty1', '123abc', 'baseball',
	'hello123', 'freedom', 'whatever', 'nicole', '11111111', 'jordan23',
	'superman', 'harley', '1234qwer', 'trustno1', 'ranger', 'master',
	'soccer', 'michael', 'daniel', 'jessica', 'mustang', 'chelsea',
	'batman', 'passw0rd', 'jordan', 'michelle', 'welcome', 'shadow',
	'cookie', 'cheese', 'flower', 'matthew', 'buster', 'summer',
	'tigger', 'robert', 'friend', 'hunter', 'pepper', 'orange',
	'merlin', 'secret', 'diamond', 'chicken', 'access', 'hockey',
	'killer', 'george', 'computer', 'michelle1', 'pepper1', 'purple',
	'master1', 'jesus', 'hello', 'charlie1', 'love', 'secret1',
	'snoopy', 'help', 'banana', 'jordan1', 'saturn', 'black',
	'turtle', 'reddog', 'paris', 'america', 'enter', 'ginger',
	'mother', 'conrad', 'hello1', 'anthony', 'mercedes', 'lucky',
	'player', 'money', 'danielle', 'warrior', 'mario', 'richard',
	'admin', 'root', 'user', 'guest', 'test', 'demo',
];

const COMMON_PASSWORD_SET = new Set(COMMON_PASSWORDS);

export function isCommonPassword(password) {
	return COMMON_PASSWORD_SET.has(String(password).toLowerCase());
}

const SEQUENCES = [
	'0123456789',
	'abcdefghijklmnopqrstuvwxyz',
	'qwertyuiop',
	'asdfghjkl',
	'zxcvbnm',
];

/** True when the password contains three consecutive characters of a keyboard or alphabet run. */
export function hasSequentialChars(password) {
	const lower = password.toLowerCase();
	for (const sequence of SEQUENCES) {
		for (let i = 0; i <= sequence.length - 3; i++) {
			if (lower.includes(sequence.substring(i, i + 3))) return true;
		}
	}
	return false;
}

/** True when the password repeats one character three or more times in a row. */
export function hasRepeatedChars(password) {
	return /(.)\1{2,}/.test(password);
}

export function calculatePasswordStrength(password) {
	let score = 0;

	if (password.length >= MIN_PASSWORD_LENGTH) score += 1;
	if (password.length >= 12) score += 1;

	if (/[a-z]/.test(password)) score += 1;
	if (/[A-Z]/.test(password)) score += 1;
	if (/[0-9]/.test(password)) score += 1;
	if (/[^a-zA-Z0-9]/.test(password)) score += 1;

	if (hasSequentialChars(password)) score -= 1;
	if (hasRepeatedChars(password)) score -= 1;
	if (isCommonPassword(password)) score -= 2;

	if (score <= 2) return PASSWORD_STRENGTH.WEAK;
	if (score <= 4) return PASSWORD_STRENGTH.MEDIUM;
	return PASSWORD_STRENGTH.STRONG;
}
