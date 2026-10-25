/**
 * The one canonical form of an address or a domain stored in an access rule or an
 * email list: trimmed and lowercase, which is what the tables' CHECKs
 * (`value = lower(value)`, `email = lower(email)`) require and what the access
 * query compares against. Callers that hand in a viewer's address get the same
 * folding, so "A@B.vn" and "a@b.vn" are one person.
 *
 * The address rules come from @sab/shared, the one definition the forms and the
 * login also use, so an address accepted in a form is never refused here. This
 * layer only turns "not an address" into null, which its callers rely on.
 *
 * `normalizeDomain` stays here: a domain has no other consumer than the access
 * rules, so it has no second copy to share with.
 */
const { EMAIL_MAX_LENGTH, normalizeEmail: foldEmail, isValidEmail } = require('@sab/shared');

const DOMAIN_SHAPE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** @returns {string|null} the lowercase address, or null when `value` is not one */
function normalizeEmail(value) {
	return typeof value === 'string' && isValidEmail(value) ? foldEmail(value) : null;
}

/** @returns {string|null} the lowercase domain, or null when `value` is not one */
function normalizeDomain(value) {
	if (typeof value !== 'string') return null;
	const domain = value.trim().toLowerCase();
	return domain.length <= EMAIL_MAX_LENGTH && DOMAIN_SHAPE.test(domain) ? domain : null;
}

module.exports = { normalizeEmail, normalizeDomain };
