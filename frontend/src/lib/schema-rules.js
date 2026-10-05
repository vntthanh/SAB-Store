/*
 * Bridges a shared (@sab/shared) schema to the `rules` object of useFieldErrors, so a form shows
 * exactly the messages the server would answer for the same input.
 *
 *   rulesFromSchema(schema, { fields, toPayload, uiRules })
 *       fields     form field names whose messages come from the schema; an issue is attached to a
 *                  field when its path (formatIssuePath, the same writer the API uses) equals the
 *                  name, so client errors and setServerErrors share keys
 *       toPayload  form values -> request payload (default: the values themselves); the schema
 *                  never sees raw form state when the two differ
 *       uiRules    rules the server cannot know (a confirmation field, a choice that only exists
 *                  in the UI); they win over the schema for the same field
 *   requiredFromSchema(schema)          { key: true } for every top-level key the schema rejects
 *                                       when it is absent: drives the red "*" of FormField
 *   leftoverIssues(schema, payload, fields)
 *                                       issues that belong to no form field (object-level
 *                                       refinements, keys the form does not render), the same
 *                                       shape as the leftovers of setServerErrors
 */
import { formatIssuePath } from '@sab/shared';

const identity = (values) => values;

const issuesOf = (schema, payload) => {
	const result = schema.safeParse(payload);
	if (result.success) return [];
	return result.error.issues.map((issue) => ({ field: formatIssuePath(issue.path), message: issue.message }));
};

const firstMessageByField = (issues) => {
	const byField = new Map();
	issues.forEach(({ field, message }) => {
		if (!byField.has(field)) byField.set(field, message);
	});
	return byField;
};

export function rulesFromSchema(schema, { fields = [], toPayload = identity, uiRules = {} }) {
	// useFieldErrors runs one rule per field with the same `values` object, so the schema runs once
	// per values object instead of once per field.
	const parsed = new WeakMap();
	const messagesFor = (values) => {
		let messages = parsed.get(values);
		if (!messages) {
			messages = firstMessageByField(issuesOf(schema, toPayload(values)));
			parsed.set(values, messages);
		}
		return messages;
	};

	const rules = {};
	const names = new Set([...fields, ...Object.keys(uiRules)]);
	names.forEach((name) => {
		const fromSchema = fields.includes(name);
		rules[name] = (value, values) => {
			const uiMessage = uiRules[name]?.(value, values);
			if (uiMessage) return uiMessage;
			if (!fromSchema) return null;
			// Blur/change handlers may pass a value newer than `values` (or no `values` at all).
			const source = values && Object.is(values[name], value) ? values : { ...values, [name]: value };
			return messagesFor(source).get(name) ?? null;
		};
	});
	return rules;
}

export function requiredFromSchema(schema) {
	const required = {};
	issuesOf(schema, {}).forEach(({ field }) => {
		const key = field.split(/[.[]/)[0];
		if (key) required[key] = true;
	});
	return required;
}

export function leftoverIssues(schema, payload, fields) {
	return issuesOf(schema, payload).filter(({ field }) => !fields.includes(field));
}
