import { z } from '../z.js';

// A student ID (MSSV) is exactly 8 digits; its first two digits are the
// intake year, accepted from K16 to K26. Widen the upper bound when a new
// intake starts (K27 in 2027) — a stale bound rejects every student of the new
// intake.
export const STUDENT_ID_PATTERN = /^(1[6-9]|2[0-6])\d{6}$/;
export const STUDENT_ID_HINT = 'Mã số sinh viên gồm 8 chữ số, từ 16xxxxxx đến 26xxxxxx';
const STUDENT_ID_REQUIRED = 'Mã số sinh viên là bắt buộc';

// An empty value reports both messages (required and format).
export const studentId = z
	.string({ error: STUDENT_ID_REQUIRED })
	.trim()
	.min(1, STUDENT_ID_REQUIRED)
	.regex(STUDENT_ID_PATTERN, STUDENT_ID_HINT);
