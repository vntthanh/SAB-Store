import { describe, it, expect } from 'vitest';

// The package is consumed through its built output, so this runs against it:
// the global Vietnamese error map is a load-bearing side effect of the entry
// module and must survive bundling.
describe('built ESM entry', () => {
	it('answers in Vietnamese through the global error map', async () => {
		const built = await import('../dist/index.js');
		expect(built.z.string().min(3).safeParse('ab').error.issues[0].message).toBe('Phải có ít nhất 3 ký tự');
		expect(built.studentId.safeParse('27123456').error.issues[0].message).toBe(built.STUDENT_ID_HINT);
		expect(built.studentId.safeParse('26123456').success).toBe(true);
	});

	it('answers in Vietnamese when only a schema is imported from it', async () => {
		const { newPassword } = await import('../dist/index.js');
		expect(newPassword.safeParse(5).error.issues[0].message).toBe('Mật khẩu là bắt buộc');
		expect(newPassword.safeParse('abc').error.issues.map((i) => i.message)).toContain('Mật khẩu phải có từ 8-128 ký tự');
	});
});
