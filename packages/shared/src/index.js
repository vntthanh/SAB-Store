// Consumers import `z` from here and never from `zod` directly: a second zod
// instance would not see the global error map registered in ./z.js.
export { z } from './z.js';
export {
	MIN_PASSWORD_LENGTH,
	MAX_PASSWORD_LENGTH,
	PASSWORD_STRENGTH,
	COMMON_PASSWORDS,
	isCommonPassword,
	hasSequentialChars,
	hasRepeatedChars,
	calculatePasswordStrength,
} from './password-rules.js';
export { STUDENT_ID_PATTERN, STUDENT_ID_HINT, studentId } from './schemas/student-id.js';
export { loginPassword, sellerPassword, newPassword, passwordChange } from './schemas/password.js';
export { toErrorList, formatIssuePath, isSensitiveField } from './schemas/parse.js';
