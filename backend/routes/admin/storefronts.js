const express = require('express');
const {
	storefrontCreate,
	storefrontUpdate,
	storefrontReorder,
	accessRuleCreate,
	emailListCreate,
	emailListUpdate,
	emailListEntriesAdd,
	normalizeEmail
} = require('@sab/shared');
const { storefronts, emailLists } = require('../../data');
const {
	ConflictError,
	CONFLICT_CODES,
	InvalidIdError,
	RecordValidationError,
	isDuplicateKeyOn,
	isDuplicateKeyError
} = require('../../data/errors');
const { ERROR_CODES, ERROR_MESSAGES } = require('../../constants/errorCodes');
const { asString, asPageLimit } = require('../../utils/query-guard');
const ErrorLogger = require('../../utils/errorLogger');
const { sendCoded } = require('./storefront-params');
const { validateBody } = require('../../middleware/validation');

// Mounted without a prefix by routes/admin.js, behind authenticateAdmin: a seller,
// a customer and an anonymous caller never reach these handlers.
const router = express.Router();

const SEARCH_MAX_LENGTH = 100;

const trimmed = (value) => (typeof value === 'string' ? value.trim() : value);
// The repositories read '' as "clear it" and null as nothing, so a body's null becomes ''.
const clearable = (value) => (value === null ? '' : trimmed(value));

/**
 * Turns what a repository throws into the response the admin UI can act on.
 * Everything unrecognised is logged and answered 500.
 */
function fail(res, error, route) {
	if (error instanceof ConflictError) {
		if (error.code === CONFLICT_CODES.STOREFRONT_IN_USE) {
			const code = ERROR_CODES.STOREFRONT_IN_USE;
			return res.status(409).json({ success: false, code, message: ERROR_MESSAGES[code].vi, details: error.details });
		}
		if (error.code === CONFLICT_CODES.LAST_ACTIVE_STOREFRONT) return sendCoded(res, ERROR_CODES.LAST_ACTIVE_STOREFRONT);
		if (error.code === CONFLICT_CODES.DEFAULT_STOREFRONT) return sendCoded(res, ERROR_CODES.DEFAULT_STOREFRONT);
		// A storefront or list deleted between the existence check and the write.
		return sendCoded(res, ERROR_CODES.REFERENCE_VIOLATION);
	}
	if (isDuplicateKeyError(error)) {
		if (isDuplicateKeyOn(error, 'slug')) return sendCoded(res, ERROR_CODES.STOREFRONT_SLUG_TAKEN);
		if (isDuplicateKeyOn(error, 'name')) return sendCoded(res, ERROR_CODES.EMAIL_LIST_NAME_TAKEN);
		if (isDuplicateKeyOn(error, 'value', 'emailListId')) return sendCoded(res, ERROR_CODES.ACCESS_RULE_DUPLICATE);
	}
	if (error instanceof RecordValidationError) {
		return res.status(400).json({
			success: false,
			code: ERROR_CODES.VALIDATION_ERROR,
			message: error.fieldErrors.map((entry) => entry.message).join(', '),
			errors: error.fieldErrors
		});
	}
	if (error instanceof InvalidIdError) {
		return res.status(400).json({ success: false, code: ERROR_CODES.VALIDATION_ERROR, message: ERROR_MESSAGES[ERROR_CODES.VALIDATION_ERROR].vi });
	}
	ErrorLogger.log(error, { route });
	return sendCoded(res, ERROR_CODES.INTERNAL_SERVER_ERROR);
}

const storefrontMissing = (res) => sendCoded(res, ERROR_CODES.STOREFRONT_NOT_FOUND);
const listMissing = (res) => sendCoded(res, ERROR_CODES.EMAIL_LIST_NOT_FOUND);
const ruleMissing = (res) => sendCoded(res, ERROR_CODES.RULE_NOT_FOUND);

// ---- storefronts ----

/** @route GET /api/admin/storefronts: every storefront, active or not, in display order. */
router.get('/storefronts', async (req, res) => {
	try {
		res.json({ success: true, data: await storefronts.listAll() });
	} catch (error) {
		fail(res, error, 'GET /admin/storefronts');
	}
});

/** @route POST /api/admin/storefronts */
router.post('/storefronts', validateBody(storefrontCreate), async (req, res) => {
	try {
		const { slug, name, description, visibility, isActive } = req.body;
		const created = await storefronts.create({
			slug,
			name: trimmed(name),
			...(description && { description: trimmed(description) }),
			visibility,
			isActive
		});
		res.status(201).json({ success: true, data: created });
	} catch (error) {
		fail(res, error, 'POST /admin/storefronts');
	}
});

// Registered before /:id so "reorder" is not read as an id.
/** @route PUT /api/admin/storefronts/reorder: the listed storefronts take their position in the list. */
router.put('/storefronts/reorder', validateBody(storefrontReorder), async (req, res) => {
	try {
		res.json({ success: true, data: await storefronts.reorder(req.body.ids) });
	} catch (error) {
		fail(res, error, 'PUT /admin/storefronts/reorder');
	}
});

/** @route PUT /api/admin/storefronts/:id */
router.put('/storefronts/:id', validateBody(storefrontUpdate), async (req, res) => {
	try {
		const { slug, name, description, visibility, isActive } = req.body;
		const updated = await storefronts.update(req.params.id, {
			slug,
			name: trimmed(name),
			description: clearable(description),
			visibility,
			isActive
		});
		if (!updated) return storefrontMissing(res);
		res.json({ success: true, data: updated });
	} catch (error) {
		fail(res, error, 'PUT /admin/storefronts/:id');
	}
});

/** @route DELETE /api/admin/storefronts/:id: 409 while products, combos or orders use it, for the default one and for the last active one. */
router.delete('/storefronts/:id', async (req, res) => {
	try {
		if (!(await storefronts.remove(req.params.id))) return storefrontMissing(res);
		res.json({ success: true, message: 'Đã xoá gian hàng' });
	} catch (error) {
		fail(res, error, 'DELETE /admin/storefronts/:id');
	}
});

// ---- access rules ----

/** @route GET /api/admin/storefronts/:id/rules */
router.get('/storefronts/:id/rules', async (req, res) => {
	try {
		if (!(await storefronts.findById(req.params.id))) return storefrontMissing(res);
		res.json({ success: true, data: await storefronts.listRules(req.params.id) });
	} catch (error) {
		fail(res, error, 'GET /admin/storefronts/:id/rules');
	}
});

/** @route POST /api/admin/storefronts/:id/rules */
router.post('/storefronts/:id/rules', validateBody(accessRuleCreate), async (req, res) => {
	try {
		const { type, value, emailListId } = req.body;
		const storefrontId = req.params.id;
		if (!(await storefronts.findById(storefrontId))) return storefrontMissing(res);

		// The repository folds EMAIL and DOMAIN values as well; doing it here keeps the
		// stored value independent of which backend answers.
		const rule = type === 'LIST'
			? { type, emailListId }
			: { type, value: type === 'EMAIL' ? normalizeEmail(value) : trimmed(value).toLowerCase() };
		if (type === 'LIST' && !(await emailLists.findById(emailListId))) return listMissing(res);

		const created = await storefronts.addRule({ storefrontId, ...rule, createdBy: req.user.id });
		res.status(201).json({ success: true, data: created });
	} catch (error) {
		fail(res, error, 'POST /admin/storefronts/:id/rules');
	}
});

/** @route DELETE /api/admin/storefronts/:id/rules/:ruleId */
router.delete('/storefronts/:id/rules/:ruleId', async (req, res) => {
	try {
		if (!(await storefronts.removeRule(req.params.id, req.params.ruleId))) return ruleMissing(res);
		res.json({ success: true, message: 'Đã xoá quy tắc' });
	} catch (error) {
		fail(res, error, 'DELETE /admin/storefronts/:id/rules/:ruleId');
	}
});

// ---- email lists ----

/** @route GET /api/admin/email-lists: every list with its entry and rule counts. */
router.get('/email-lists', async (req, res) => {
	try {
		res.json({ success: true, data: await emailLists.list() });
	} catch (error) {
		fail(res, error, 'GET /admin/email-lists');
	}
});

/** @route POST /api/admin/email-lists */
router.post('/email-lists', validateBody(emailListCreate), async (req, res) => {
	try {
		const { name, description } = req.body;
		const created = await emailLists.create({ name: trimmed(name), ...(description && { description: trimmed(description) }) });
		res.status(201).json({ success: true, data: created });
	} catch (error) {
		fail(res, error, 'POST /admin/email-lists');
	}
});

/** @route PUT /api/admin/email-lists/:id */
router.put('/email-lists/:id', validateBody(emailListUpdate), async (req, res) => {
	try {
		const { name, description } = req.body;
		const updated = await emailLists.update(req.params.id, { name: trimmed(name), description: clearable(description) });
		if (!updated) return listMissing(res);
		res.json({ success: true, data: updated });
	} catch (error) {
		fail(res, error, 'PUT /admin/email-lists/:id');
	}
});

/** @route DELETE /api/admin/email-lists/:id: also removes the rules that name the list (those storefronts admit fewer people). */
router.delete('/email-lists/:id', async (req, res) => {
	try {
		if (!(await emailLists.remove(req.params.id))) return listMissing(res);
		res.json({ success: true, message: 'Đã xoá danh sách email' });
	} catch (error) {
		fail(res, error, 'DELETE /admin/email-lists/:id');
	}
});

/** @route GET /api/admin/email-lists/:id/entries?page&limit&search */
router.get('/email-lists/:id/entries', async (req, res) => {
	try {
		if (!(await emailLists.findById(req.params.id))) return listMissing(res);
		const { page, limit } = asPageLimit(req.query.page, req.query.limit);
		const { data, meta } = await emailLists.entriesPage(req.params.id, { page, limit, search: asString(req.query.search, SEARCH_MAX_LENGTH) });
		res.json({ success: true, data, meta });
	} catch (error) {
		fail(res, error, 'GET /admin/email-lists/:id/entries');
	}
});

/** @route POST /api/admin/email-lists/:id/entries: `{ added, skipped }`; an address already there, or repeated, counts as skipped. */
router.post('/email-lists/:id/entries', validateBody(emailListEntriesAdd), async (req, res) => {
	try {
		const result = await emailLists.addEntries(req.params.id, req.body.emails);
		if (!result) return listMissing(res);
		res.json({ success: true, data: result });
	} catch (error) {
		fail(res, error, 'POST /admin/email-lists/:id/entries');
	}
});

/** @route DELETE /api/admin/email-lists/:id/entries: empties the list. */
router.delete('/email-lists/:id/entries', async (req, res) => {
	try {
		if (!(await emailLists.findById(req.params.id))) return listMissing(res);
		res.json({ success: true, data: { removed: await emailLists.clear(req.params.id) } });
	} catch (error) {
		fail(res, error, 'DELETE /admin/email-lists/:id/entries');
	}
});

/** @route DELETE /api/admin/email-lists/:id/entries/:entryId */
router.delete('/email-lists/:id/entries/:entryId', async (req, res) => {
	try {
		if (!(await emailLists.removeEntry(req.params.id, req.params.entryId))) {
			return sendCoded(res, ERROR_CODES.EMAIL_ENTRY_NOT_FOUND);
		}
		res.json({ success: true, message: 'Đã xoá email khỏi danh sách' });
	} catch (error) {
		fail(res, error, 'DELETE /admin/email-lists/:id/entries/:entryId');
	}
});

module.exports = router;
