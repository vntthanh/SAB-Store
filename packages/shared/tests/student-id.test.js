import { describe, it, expect } from 'vitest';
import { studentId, STUDENT_ID_PATTERN, STUDENT_ID_HINT } from '../src/index.js';

const REQUIRED = 'Mã số sinh viên là bắt buộc';

describe('studentId', () => {
	it.each(['16000001', '19999999', '20123456', '25123456', '26123456'])('accepts %s', (id) => {
		expect(studentId.safeParse(id)).toMatchObject({ success: true, data: id });
	});

	it.each(['15123456', '27123456', '06123456', '2612345', '261234567', 'SV261234', '2612 3456', '26123456x'])(
		'rejects %s with the hint',
		(id) => {
			const result = studentId.safeParse(id);
			expect(result.success).toBe(false);
			expect(result.error.issues.map((i) => i.message)).toEqual([STUDENT_ID_HINT]);
		},
	);

	it('trims surrounding whitespace before checking', () => {
		expect(studentId.safeParse('  26123456 ')).toMatchObject({ success: true, data: '26123456' });
	});

	it('reports required and format for an empty or blank value', () => {
		for (const blank of ['', '   ']) {
			const result = studentId.safeParse(blank);
			expect(result.error.issues.map((i) => i.message)).toEqual([REQUIRED, STUDENT_ID_HINT]);
		}
	});

	it('reports required for a missing or non-string value', () => {
		for (const value of [undefined, null, 26123456]) {
			expect(studentId.safeParse(value).error.issues.map((i) => i.message)).toEqual([REQUIRED]);
		}
	});

	it('keeps the exported pattern in step with the schema', () => {
		expect(STUDENT_ID_PATTERN.test('26123456')).toBe(true);
		expect(STUDENT_ID_PATTERN.test('27123456')).toBe(false);
	});
});
