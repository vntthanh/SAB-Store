// Mirrors backend/utils/student-id.js (the server check is authoritative).
export const STUDENT_ID_PATTERN = /^(1[6-9]|2[0-6])\d{6}$/;
export const STUDENT_ID_HINT = 'Mã số sinh viên gồm 8 chữ số, từ 16xxxxxx đến 26xxxxxx';
