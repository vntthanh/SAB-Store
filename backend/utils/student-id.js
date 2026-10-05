// The rule lives in @sab/shared so the server check and the client's instant
// feedback cannot drift apart.
const { STUDENT_ID_PATTERN } = require('@sab/shared');

module.exports = { STUDENT_ID_PATTERN };
