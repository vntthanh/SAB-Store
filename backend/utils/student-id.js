// A student ID (MSSV) is exactly 8 digits; its first two digits are the
// intake year, accepted from K16 to K26. Widen the upper bound when a new
// intake starts (K27 in 2027) — the previous rule stopped at 25 and rejected
// every K26 student. frontend/src/utils/student-id.js repeats this pattern for
// instant feedback; keep the two in sync.
const STUDENT_ID_PATTERN = /^(1[6-9]|2[0-6])\d{6}$/;

module.exports = { STUDENT_ID_PATTERN };
