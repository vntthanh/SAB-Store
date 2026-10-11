/**
 * Store-wide write gate: lets a restore replace the data while no order or
 * stock write is half done, and keeps new ones out until it has finished.
 *
 * Writers (anything that creates or changes orders, stock or products) run
 * inside `gated(handler)`. A restore calls `close()`, which refuses new writers
 * and waits for the running ones, then `open()` in a `finally`.
 *
 * State is per process. That is correct while the backend is one instance; if
 * it is ever scaled out the gate must move into the database (or another shared
 * store), because a second instance would keep accepting orders mid-restore.
 */
const { ERROR_CODES, ERROR_MESSAGES, ERROR_CODE_TO_HTTP_STATUS } = require('../constants/errorCodes');

const DEFAULT_DRAIN_TIMEOUT_MS = 15000;

class WriteGateError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

let closed = false;
let active = 0;
let onIdle = null;

/** Take a writer slot. False while a restore holds the gate. */
function enter() {
	if (closed) return false;
	active++;
	return true;
}

function leave() {
	active--;
	if (active === 0 && onIdle) onIdle();
}

/**
 * Refuse new writers and wait until the running ones have left.
 *
 * @throws {WriteGateError} RESTORE_IN_PROGRESS when already closed;
 *   RESTORE_BUSY when writers are still running after `timeoutMs` (the gate is
 *   reopened first, so a stuck writer cannot lock the store out)
 */
async function close({ timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
	if (closed) throw new WriteGateError(ERROR_CODES.RESTORE_IN_PROGRESS, 'Another restore is already running');
	closed = true;
	if (active === 0) return;

	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			onIdle = null;
			closed = false;
			reject(new WriteGateError(ERROR_CODES.RESTORE_BUSY, `${active} write(s) still running after ${timeoutMs}ms`));
		}, timeoutMs);
		onIdle = () => {
			clearTimeout(timer);
			onIdle = null;
			resolve();
		};
	});
}

function open() {
	closed = false;
}

/** Wrap an Express handler so it counts as a writer, or answers 503 during a restore. */
function gated(handler) {
	return async (req, res, next) => {
		if (!enter()) {
			const code = ERROR_CODES.STORE_RESTORING;
			const message = ERROR_MESSAGES[code].vi;
			return res.status(ERROR_CODE_TO_HTTP_STATUS[code]).json({ success: false, error: message, message, code });
		}
		try {
			await handler(req, res, next);
		} catch (error) {
			next(error);
		} finally {
			leave();
		}
	};
}

module.exports = { close, open, gated, WriteGateError };
