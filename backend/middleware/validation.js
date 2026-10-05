const {
	toErrorList,
	isPlainObject,
	orderCreate,
	directOrder,
	orderUpdate,
	orderItemsEdit,
	orderNotes,
	orderIdParams,
	passwordChange,
	makeComboItems,
} = require('@sab/shared');
const { MAX_UNITS_PER_ORDER } = require('../services/pricing');

/**
 * Validates `req.params` and `req.body` against shared schemas and answers
 * 400 { message, errors: [{ field, message, value? }] } when either fails.
 *
 * It only validates. `req.body` is never replaced with the parsed result and
 * unknown keys are not stripped: handlers keep choosing their fields
 * explicitly, so a client can still not smuggle a field into a write by
 * adding it to the body. A handler that needs a trimmed or numeric value
 * converts it itself (see trimText).
 *
 * A body that is not an object (an array, which JSON parsing lets through)
 * is validated as an empty one, so it reports the missing fields.
 */
const validateRequest = ({ params, body }) => (req, res, next) => {
	const errors = [];

	if (params) {
		const result = params.safeParse(req.params);
		if (!result.success) errors.push(...toErrorList(result.error.issues, req.params));
	}

	if (body) {
		const input = isPlainObject(req.body) ? req.body : {};
		const result = body.safeParse(input);
		if (!result.success) errors.push(...toErrorList(result.error.issues, input));
	}

	if (errors.length > 0) {
		return res.status(400).json({ message: 'Dữ liệu không hợp lệ', errors });
	}
	next();
};

const validateBody = (schema) => validateRequest({ body: schema });

/**
 * What a text field looked like once validation was done with it: trimmed, null
 * read as '', absent left absent. Handlers apply it to the text they store
 * because validation does not rewrite the request.
 */
const trimText = (value) => (value === undefined ? undefined : String(value ?? '').trim());

/** The optional text of a status update, trimmed for storage. */
const trimStatusText = (body) => ({
	transactionCode: trimText(body.transactionCode),
	cancelReason: trimText(body.cancelReason),
	note: trimText(body.note),
});

const validateOrder = validateBody(orderCreate);
const validateDirectOrder = validateBody(directOrder);
const validateOrderUpdate = validateRequest({ params: orderIdParams, body: orderUpdate });
const validateOrderItemsEdit = validateRequest({ params: orderIdParams, body: orderItemsEdit });
const validateOrderNotes = validateRequest({ params: orderIdParams, body: orderNotes });
const validateComboItems = validateBody(makeComboItems({ maxUnits: MAX_UNITS_PER_ORDER }));
const validatePasswordChange = validateBody(passwordChange);

module.exports = {
	trimText,
	trimStatusText,
	validateOrder,
	validateDirectOrder,
	validateOrderUpdate,
	validateOrderNotes,
	validateOrderItemsEdit,
	validateComboItems,
	validatePasswordChange,
};
