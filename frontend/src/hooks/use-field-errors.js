/*
 * useFieldErrors(rules) -> field error state for FormField.
 *
 * rules: { field: (value, values) => message | null }  (module-level constant)
 *
 *   errors                      { field: message } currently displayed
 *   validateField(name, value, values?)  blur handler: marks touched, shows/clears the error; a
 *                                        server error stays while the value is the one it was set for
 *   onFieldChange(name, value, values?)  change handler: re-validates only a field that is
 *                                        already touched, errored (client or server), or
 *                                        after a submit attempt; never nags while typing first time
 *   validateAll(values)         submit gate: shows every error, returns true when all pass
 *   setServerErrors(apiError)   maps apiError.fieldErrors ([{ field, message }]) onto known
 *                               fields; returns the leftovers (array) for the caller to toast
 *   focusFirstError(formRef)    focuses the first [aria-invalid="true"] inside the form
 *   reset()                     clears errors, touched and submit-attempt state
 */
import { useCallback, useRef, useState } from 'react';

const useFieldErrors = (rules) => {
	const [errors, setErrors] = useState({});
	const errorsRef = useRef(errors);
	const touchedRef = useRef({});
	const submittedRef = useRef(false);
	// Server messages stay valid only for the value they were returned for ({ message, value });
	// lastValuesRef is how setServerErrors knows which value that was without the caller passing it.
	const serverRef = useRef({});
	const lastValuesRef = useRef({});
	const rulesRef = useRef(rules);
	rulesRef.current = rules;

	const commit = useCallback((next) => {
		errorsRef.current = next;
		setErrors(next);
	}, []);

	const setOne = useCallback((name, message) => {
		const next = { ...errorsRef.current };
		if (message) next[name] = message;
		else delete next[name];
		commit(next);
	}, [commit]);

	const runRule = useCallback((name, value, values) => {
		const rule = rulesRef.current[name];
		return rule ? rule(value, values) : null;
	}, []);

	// Client rule first; otherwise a server message survives only while the value is unchanged.
	const evaluate = useCallback((name, value, values) => {
		lastValuesRef.current[name] = value;
		const clientMessage = runRule(name, value, values);
		if (clientMessage) return clientMessage;
		const server = serverRef.current[name];
		if (!server) return null;
		if (Object.is(server.value, value)) return server.message;
		delete serverRef.current[name];
		return null;
	}, [runRule]);

	const validateField = useCallback((name, value, values) => {
		touchedRef.current[name] = true;
		setOne(name, evaluate(name, value, values));
	}, [setOne, evaluate]);

	const onFieldChange = useCallback((name, value, values) => {
		const message = evaluate(name, value, values);
		if (touchedRef.current[name] || submittedRef.current || errorsRef.current[name]) {
			setOne(name, message);
		}
	}, [setOne, evaluate]);

	const validateAll = useCallback((values) => {
		submittedRef.current = true;
		// A new attempt re-asks the server, so earlier server verdicts must not block it.
		serverRef.current = {};
		const next = {};
		Object.keys(rulesRef.current).forEach((name) => {
			touchedRef.current[name] = true;
			lastValuesRef.current[name] = values[name];
			const message = runRule(name, values[name], values);
			if (message) next[name] = message;
		});
		commit(next);
		return Object.keys(next).length === 0;
	}, [commit, runRule]);

	const setServerErrors = useCallback((apiError) => {
		const list = Array.isArray(apiError?.fieldErrors) ? apiError.fieldErrors : [];
		const next = { ...errorsRef.current };
		const leftovers = [];
		list.forEach(({ field, message }) => {
			if (Object.prototype.hasOwnProperty.call(rulesRef.current, field)) {
				serverRef.current[field] = { message, value: lastValuesRef.current[field] };
				if (!next[field]) next[field] = message;
			} else {
				leftovers.push({ field, message });
			}
		});
		commit(next);
		return leftovers;
	}, [commit]);

	const reset = useCallback(() => {
		touchedRef.current = {};
		submittedRef.current = false;
		serverRef.current = {};
		lastValuesRef.current = {};
		commit({});
	}, [commit]);

	// Runs after React has committed the aria-invalid attributes of this render.
	const focusFirstError = useCallback((formRef) => {
		requestAnimationFrame(() => {
			formRef?.current?.querySelector('[aria-invalid="true"]')?.focus();
		});
	}, []);

	return { errors, validateField, onFieldChange, validateAll, setServerErrors, focusFirstError, reset };
};

export default useFieldErrors;
