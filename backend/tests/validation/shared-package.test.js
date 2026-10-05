const shared = require('@sab/shared');
const {
	validatePassword,
	getPasswordStrengthIndicators,
	createPasswordValidationRules,
	COMMON_PASSWORDS,
	PASSWORD_STRENGTH,
} = require('../../utils/passwordValidator');
const { STUDENT_ID_PATTERN } = require('../../utils/student-id');

// Pinned outputs: [input, validatePassword(input), getPasswordStrengthIndicators(input)].
// A null indicator row is an input the indicator helper does not accept.
const RECORDED = [
	["", {"success": false, "errors": ["Mật khẩu là bắt buộc"], "warnings": [], "strength": "weak"}, {"indicators": {"length": false, "lowercase": false, "uppercase": false, "notCommon": true, "overall": false}, "strength": "weak", "errors": ["Mật khẩu là bắt buộc"], "warnings": []}],
	[undefined, {"success": false, "errors": ["Mật khẩu là bắt buộc"], "warnings": [], "strength": "weak"}, {"indicators": {"length": false, "lowercase": false, "uppercase": false, "notCommon": true, "overall": false}, "strength": "weak", "errors": ["Mật khẩu là bắt buộc"], "warnings": []}],
	[null, {"success": false, "errors": ["Mật khẩu là bắt buộc"], "warnings": [], "strength": "weak"}, {"indicators": {"length": false, "lowercase": false, "uppercase": false, "notCommon": true, "overall": false}, "strength": "weak", "errors": ["Mật khẩu là bắt buộc"], "warnings": []}],
	[123, {"success": false, "errors": ["Mật khẩu là bắt buộc"], "warnings": [], "strength": "weak"}, null],
	["1234567", {"success": false, "errors": ["Mật khẩu phải có ít nhất 8 ký tự", "Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)", "Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"], "strength": "weak"}, {"indicators": {"length": false, "lowercase": false, "uppercase": false, "notCommon": false, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải có ít nhất 8 ký tự", "Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)", "Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"]}],
	["12345678", {"success": false, "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)", "Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"], "strength": "weak"}, {"indicators": {"length": true, "lowercase": false, "uppercase": false, "notCommon": false, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)", "Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"]}],
	["Abcdefg1", {"success": true, "errors": [], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"], "strength": "medium"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": true}, "strength": "medium", "errors": [], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"]}],
	["abcdefgh", {"success": false, "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"], "strength": "weak"}, {"indicators": {"length": true, "lowercase": true, "uppercase": false, "notCommon": true, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"]}],
	["ABCDEFGH", {"success": false, "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"], "strength": "weak"}, {"indicators": {"length": true, "lowercase": false, "uppercase": true, "notCommon": true, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"]}],
	["Password1", {"success": false, "errors": ["Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": [], "strength": "weak"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": false, "overall": false}, "strength": "weak", "errors": ["Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": []}],
	["  Abcdefg1  ", {"success": true, "errors": [], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"], "strength": "medium"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": true}, "strength": "medium", "errors": [], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"]}],
	["   a   ", {"success": false, "errors": ["Mật khẩu phải có ít nhất 8 ký tự", "Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)"], "warnings": [], "strength": "weak"}, {"indicators": {"length": false, "lowercase": true, "uppercase": false, "notCommon": true, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải có ít nhất 8 ký tự", "Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)"], "warnings": []}],
	["AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa", {"success": true, "errors": [], "warnings": [], "strength": "medium"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": true}, "strength": "medium", "errors": [], "warnings": []}],
	["AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAax", {"success": false, "errors": ["Mật khẩu không được vượt quá 128 ký tự"], "warnings": [], "strength": "medium"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": false}, "strength": "medium", "errors": ["Mật khẩu không được vượt quá 128 ký tự"], "warnings": []}],
	["Qwerty123", {"success": false, "errors": ["Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"], "strength": "weak"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": false, "overall": false}, "strength": "weak", "errors": ["Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"]}],
	["123456", {"success": false, "errors": ["Mật khẩu phải có ít nhất 8 ký tự", "Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)", "Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"], "strength": "weak"}, {"indicators": {"length": false, "lowercase": false, "uppercase": false, "notCommon": false, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải có ít nhất 8 ký tự", "Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)", "Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"]}],
	["password", {"success": false, "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": [], "strength": "weak"}, {"indicators": {"length": true, "lowercase": true, "uppercase": false, "notCommon": false, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": []}],
	["PASSWORD1", {"success": false, "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": [], "strength": "weak"}, {"indicators": {"length": true, "lowercase": false, "uppercase": true, "notCommon": false, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": []}],
	["Abc12345", {"success": true, "errors": [], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"], "strength": "medium"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": true}, "strength": "medium", "errors": [], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật"]}],
	["Abcabc111", {"success": true, "errors": [], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật", "Mật khẩu chứa nhiều ký tự giống nhau, nên tránh để tăng bảo mật"], "strength": "weak"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": true}, "strength": "weak", "errors": [], "warnings": ["Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật", "Mật khẩu chứa nhiều ký tự giống nhau, nên tránh để tăng bảo mật"]}],
	["Str0ng!Passw0rd", {"success": true, "errors": [], "warnings": [], "strength": "strong"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": true}, "strength": "strong", "errors": [], "warnings": []}],
	["aaaaaaaaA", {"success": true, "errors": [], "warnings": ["Mật khẩu chứa nhiều ký tự giống nhau, nên tránh để tăng bảo mật"], "strength": "weak"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": true}, "strength": "weak", "errors": [], "warnings": ["Mật khẩu chứa nhiều ký tự giống nhau, nên tránh để tăng bảo mật"]}],
	["Zq9!xK2#mW4$", {"success": true, "errors": [], "warnings": [], "strength": "strong"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": true}, "strength": "strong", "errors": [], "warnings": []}],
	["passw0rd", {"success": false, "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": [], "strength": "weak"}, {"indicators": {"length": true, "lowercase": true, "uppercase": false, "notCommon": false, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)", "Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": []}],
	["Passw0rd", {"success": false, "errors": ["Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": [], "strength": "weak"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": false, "overall": false}, "strength": "weak", "errors": ["Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác"], "warnings": []}],
	["ADMINADMIN", {"success": false, "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)"], "warnings": [], "strength": "weak"}, {"indicators": {"length": true, "lowercase": false, "uppercase": true, "notCommon": true, "overall": false}, "strength": "weak", "errors": ["Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)"], "warnings": []}],
	["Welcome1", {"success": true, "errors": [], "warnings": [], "strength": "medium"}, {"indicators": {"length": true, "lowercase": true, "uppercase": true, "notCommon": true, "overall": true}, "strength": "medium", "errors": [], "warnings": []}],
];

describe('utils/passwordValidator on top of @sab/shared', () => {
	it.each(RECORDED)('validatePassword(%j) is unchanged', (input, expected) => {
		expect(validatePassword(input)).toEqual(expected);
	});

	it.each(RECORDED.filter((row) => row[2] !== null))('getPasswordStrengthIndicators(%j) is unchanged', (input, _validation, expected) => {
		expect(getPasswordStrengthIndicators(input)).toEqual(expected);
	});

	it('re-exports the shared blocklist and strength levels that lib/auth.js relies on', () => {
		expect(COMMON_PASSWORDS).toBe(shared.COMMON_PASSWORDS);
		expect(PASSWORD_STRENGTH).toBe(shared.PASSWORD_STRENGTH);
		expect(COMMON_PASSWORDS).toContain('123456');
		expect(typeof createPasswordValidationRules).toBe('function');
	});

	it('lib/auth.js still loads with the re-exported blocklist', () => {
		expect(() => require('../../lib/auth')).not.toThrow();
	});
});

describe('@sab/shared from the CommonJS backend', () => {
	it('resolves to the built CommonJS entry and runs a schema', () => {
		expect(shared.studentId.safeParse('26123456').success).toBe(true);
		expect(shared.studentId.safeParse('27123456').success).toBe(false);
		expect(STUDENT_ID_PATTERN).toBe(shared.STUDENT_ID_PATTERN);
	});

	it('answers in Vietnamese through the global error map', () => {
		const result = shared.z.string().min(3).safeParse('ab');
		expect(result.error.issues[0].message).toBe('Phải có ít nhất 3 ký tự');
	});
});
