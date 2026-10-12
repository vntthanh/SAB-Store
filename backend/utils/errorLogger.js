const { ERROR_CODES } = require('../constants/errorCodes');
const { backendName } = require('../data/backend-name');

// Single segment after /api/orders only, so the collection itself keeps its path.
const PUBLIC_ORDER_LOOKUP = /^\/api\/orders\/[^/]+\/?$/i;

// scheme://user:password@host: Prisma, pg and MongoDB errors can quote the connection
// string they were given. Greedy up to the last '@' of the token so a password that
// contains a raw '@' or '/' is removed whole; the host stays for diagnosis.
const CONNECTION_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s'"`]*@/gi;

const REDACTED = '[redacted]';
const CONNECTION_ENV_NAMES = ['DATABASE_URL', 'MONGODB_URI'];
// A shorter password would blank out ordinary words in every log line.
const MIN_SECRET_LENGTH = 4;

// The password of the first `scheme://user:password@` in a connection string. The
// authority runs to the last '@' before the path so a raw '@' in the password
// stays inside it.
function passwordOf(connectionString) {
	const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(connectionString);
	if (!match) return null;
	const colon = match[1].indexOf(':');
	return colon === -1 ? null : match[1].slice(colon + 1);
}

function decoded(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

// The regex below stops at a quote or backtick, so a password holding one would
// leak its tail. The configured passwords are known exactly: replace them as
// written, percent-decoded, re-encoded and JSON-escaped (the logger prints JSON).
function configuredSecrets() {
	const secrets = new Set();
	for (const name of CONNECTION_ENV_NAMES) {
		const stored = process.env[name] ? passwordOf(process.env[name]) : null;
		if (!stored) continue;
		const plain = decoded(stored);
		for (const form of [stored, plain, encodeURIComponent(plain)]) {
			if (form.length < MIN_SECRET_LENGTH) continue;
			secrets.add(form);
			secrets.add(JSON.stringify(form).slice(1, -1));
		}
	}
	// Longest first: a password that contains another one is replaced whole.
	return [...secrets].sort((a, b) => b.length - a.length);
}

function redactCredentials(text) {
	if (typeof text !== 'string') return text;
	let safe = text;
	for (const secret of configuredSecrets()) safe = safe.split(secret).join(REDACTED);
	return safe.replace(CONNECTION_USERINFO, `$1${REDACTED}@`);
}

// Explicit fields only: util.inspect and String(error) include own properties,
// and a Node TypeError from `new URL` carries the whole URL in `input`.
function describeError(error) {
	const isObject = error !== null && typeof error === 'object';
	const message = typeof error === 'string' ? error : isObject && typeof error.message === 'string' ? error.message : 'Non-error value thrown';
	const code = isObject && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : undefined;
	return {
		name: isObject && typeof error.name === 'string' ? error.name : undefined,
		message: redactCredentials(message),
		stack: isObject && typeof error.stack === 'string' ? redactCredentials(error.stack) : undefined,
		code
	};
}

// The context of a log call is free-form, so the printed text is redacted as a whole.
function printJson(label, info) {
	console.error(label, redactCredentials(JSON.stringify(info, null, 2)));
}

class ErrorLogger {
	// An order code is the only credential of the public tracking lookup and the
	// query string can carry tokens, so neither may reach the shared log.
	static safePath(url) {
		const path = String(url || '').split('?')[0];
		return PUBLIC_ORDER_LOOKUP.test(path) ? '/api/orders/:code' : path;
	}

	static log(error, context = {}) {
		const timestamp = new Date().toISOString();
		const { message, stack } = describeError(error);
		const errorInfo = {
			timestamp,
			errorCode: error.errorCode || ERROR_CODES.INTERNAL_SERVER_ERROR,
			message,
			stack,
			context: {
				...context,
				userId: context.userId || 'anonymous',
				ip: context.ip || 'unknown',
				userAgent: context.userAgent || 'unknown'
			}
		};

		if (error.isOperational) {
			printJson('[OPERATIONAL ERROR]', errorInfo);
		} else {
			printJson('[SYSTEM ERROR]', errorInfo);
		}

		return errorInfo;
	}

	static logRoute(routeName, error, req) {
		const path = this.safePath(req.originalUrl || req.url);
		const isOrderLookup = path === '/api/orders/:code';
		const context = {
			route: routeName,
			method: req.method,
			url: path,
			params: isOrderLookup ? { code: '[REDACTED]' } : req.params,
			queryKeys: Object.keys(req.query || {}),
			body: this.sanitizeBody(req.body),
			ip: req.ip || req.connection?.remoteAddress,
			userAgent: req.get('user-agent'),
			userId: req.user?.id || req.session?.userId
		};

		return this.log(error, context);
	}

	static logDatabase(operation, error, details = {}) {
		const context = {
			operation,
			database: backendName === 'postgres' ? 'postgresql' : 'mongodb',
			collection: details.collection,
			query: details.query,
			errorName: error.name,
			errorCode: error.code
		};

		return this.log(error, context);
	}

	static logExternalService(serviceName, error, details = {}) {
		const context = {
			service: serviceName,
			endpoint: details.endpoint,
			method: details.method,
			statusCode: details.statusCode,
			responseData: details.responseData
		};

		return this.log(error, context);
	}

	static sanitizeBody(body) {
		if (!body || typeof body !== 'object') return body;

		const sanitized = { ...body };
		const sensitiveFields = [
			'password', 'token', 'apiKey', 'secret', 'creditCard',
			// Student PII: this app stores real names, emails, phone numbers and
			// student IDs for 430+ live orders — logs must not become a second,
			// unaudited copy of that data.
			'email', 'phoneNumber', 'studentId', 'fullName'
		];

		const sanitizeRecursive = (obj) => {
			for (const key in obj) {
				if (sensitiveFields.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
					obj[key] = '[REDACTED]';
				} else if (typeof obj[key] === 'object' && obj[key] !== null) {
					sanitizeRecursive(obj[key]);
				}
			}
		};

		sanitizeRecursive(sanitized);
		return sanitized;
	}

	static logInfo(message, context = {}) {
		console.log(`[INFO] ${new Date().toISOString()} - ${message}`,
			Object.keys(context).length > 0 ? context : ''
		);
	}

	static logWarning(message, context = {}) {
		console.warn(`[WARN] ${new Date().toISOString()} - ${message}`,
			Object.keys(context).length > 0 ? context : ''
		);
	}

	static logDebug(message, context = {}) {
		if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
			console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`,
				Object.keys(context).length > 0 ? context : ''
			);
		}
	}

	static logRequest(req) {
		const logData = {
			timestamp: new Date().toISOString(),
			method: req.method,
			url: req.originalUrl || req.url,
			ip: req.ip || req.connection?.remoteAddress,
			userAgent: req.get('user-agent'),
			userId: req.user?.id || 'anonymous'
		};

		console.log(`[REQUEST] ${logData.method} ${logData.url}`, logData);
	}

	static logCritical(message, error, context = {}) {
		const criticalInfo = {
			timestamp: new Date().toISOString(),
			level: 'CRITICAL',
			message,
			error: describeError(error),
			context: {
				...context,
				processUptime: process.uptime(),
				memoryUsage: process.memoryUsage(),
				nodeVersion: process.version,
				platform: process.platform,
				pid: process.pid
			}
		};

		printJson('[CRITICAL]', criticalInfo);

		return criticalInfo;
	}

	static logUncaughtException(error, origin = 'uncaughtException') {
		const criticalInfo = {
			timestamp: new Date().toISOString(),
			level: 'CRITICAL',
			type: origin,
			error: describeError(error),
			process: {
				uptime: process.uptime(),
				memoryUsage: process.memoryUsage(),
				cpuUsage: process.cpuUsage(),
				nodeVersion: process.version,
				platform: process.platform,
				pid: process.pid,
				cwd: process.cwd()
			},
			environment: {
				nodeEnv: process.env.NODE_ENV,
				port: process.env.PORT
			}
		};

		printJson(`[${origin.toUpperCase()}]`, criticalInfo);

		if (process.env.NODE_ENV === 'production') {
			console.error('[ACTION] Application will restart to maintain stability');
		}

		return criticalInfo;
	}

	static logUnhandledRejection(reason, promise) {
		const rejectionInfo = {
			timestamp: new Date().toISOString(),
			level: 'CRITICAL',
			type: 'unhandledRejection',
			error: describeError(reason),
			promise: Object.prototype.toString.call(promise),
			process: {
				uptime: process.uptime(),
				memoryUsage: process.memoryUsage(),
				nodeVersion: process.version,
				pid: process.pid
			}
		};

		printJson('[UNHANDLED REJECTION]', rejectionInfo);

		return rejectionInfo;
	}

	static logShutdown(signal, context = {}) {
		const shutdownInfo = {
			timestamp: new Date().toISOString(),
			level: 'INFO',
			signal,
			context: {
				...context,
				processUptime: process.uptime(),
				memoryUsage: process.memoryUsage()
			}
		};

		console.log('[SHUTDOWN]', JSON.stringify(shutdownInfo, null, 2));

		return shutdownInfo;
	}
}

module.exports = ErrorLogger;
