const { ERROR_CODES } = require('../constants/errorCodes');

class ErrorLogger {
	static log(error, context = {}) {
		const timestamp = new Date().toISOString();
		const errorInfo = {
			timestamp,
			errorCode: error.errorCode || ERROR_CODES.INTERNAL_SERVER_ERROR,
			message: error.message,
			stack: error.stack,
			context: {
				...context,
				userId: context.userId || 'anonymous',
				ip: context.ip || 'unknown',
				userAgent: context.userAgent || 'unknown'
			}
		};

		if (error.isOperational) {
			console.error('[OPERATIONAL ERROR]', JSON.stringify(errorInfo, null, 2));
		} else {
			console.error('[SYSTEM ERROR]', JSON.stringify(errorInfo, null, 2));
		}

		return errorInfo;
	}

	static logRoute(routeName, error, req) {
		const context = {
			route: routeName,
			method: req.method,
			url: req.originalUrl || req.url,
			params: req.params,
			query: req.query,
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
			database: 'mongodb',
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
			error: {
				name: error.name,
				message: error.message,
				stack: error.stack,
				code: error.code
			},
			context: {
				...context,
				processUptime: process.uptime(),
				memoryUsage: process.memoryUsage(),
				nodeVersion: process.version,
				platform: process.platform,
				pid: process.pid
			}
		};

		console.error('[CRITICAL]', JSON.stringify(criticalInfo, null, 2));

		return criticalInfo;
	}

	static logUncaughtException(error, origin = 'uncaughtException') {
		const criticalInfo = {
			timestamp: new Date().toISOString(),
			level: 'CRITICAL',
			type: origin,
			error: {
				name: error.name,
				message: error.message,
				stack: error.stack,
				code: error.code
			},
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

		console.error(`[${origin.toUpperCase()}]`, JSON.stringify(criticalInfo, null, 2));

		if (process.env.NODE_ENV === 'production') {
			console.error('[ACTION] Application will restart to maintain stability');
		}

		return criticalInfo;
	}

	static logUnhandledRejection(reason, promise) {
		const error = reason instanceof Error ? reason : new Error(String(reason));

		const rejectionInfo = {
			timestamp: new Date().toISOString(),
			level: 'CRITICAL',
			type: 'unhandledRejection',
			reason: String(reason),
			error: {
				name: error.name,
				message: error.message,
				stack: error.stack
			},
			promise: promise.toString(),
			process: {
				uptime: process.uptime(),
				memoryUsage: process.memoryUsage(),
				nodeVersion: process.version,
				pid: process.pid
			}
		};

		console.error('[UNHANDLED REJECTION]', JSON.stringify(rejectionInfo, null, 2));

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
