// Turns Zod issues into the error list the API has always returned:
// `[{ field, message, value? }]`, with `field` written like `items[0].quantity`.

// A rejected value of these fields must never be echoed back: a wrong password
// would otherwise appear verbatim in the response.
const SENSITIVE_FIELDS = ['password', 'token', 'secret', 'apikey', 'creditcard'];

export function isSensitiveField(field) {
	const name = String(field).toLowerCase();
	return SENSITIVE_FIELDS.some((fragment) => name.includes(fragment));
}

/** `['items', 0, 'quantity']` becomes `items[0].quantity`; the root path becomes `''`. */
export function formatIssuePath(path) {
	let out = '';
	for (const segment of path) {
		if (typeof segment === 'number') out += `[${segment}]`;
		else out += out === '' ? String(segment) : `.${String(segment)}`;
	}
	return out;
}

function valueAt(body, path) {
	let current = body;
	for (const segment of path) {
		if (current === null || typeof current !== 'object') return undefined;
		current = current[segment];
	}
	return current;
}

/**
 * @param {ReadonlyArray<{ path: ReadonlyArray<string | number>, message: string }>} issues
 * @param {unknown} body the original, unparsed input: the echoed `value` is what
 *   the client sent, not what a transform produced
 * @returns {Array<{ field: string, message: string, value?: unknown }>} in issue order,
 *   which a schema fixes, so the list is stable for a given input
 */
export function toErrorList(issues, body) {
	return issues.map((issue) => {
		const field = formatIssuePath(issue.path);
		const entry = { field, message: issue.message };
		// A root-level issue (empty path) would otherwise echo the whole body,
		// credentials included.
		if (issue.path.length > 0 && !isSensitiveField(field)) entry.value = valueAt(body, issue.path);
		return entry;
	});
}
