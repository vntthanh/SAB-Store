const { ERROR_CODES, ERROR_MESSAGES, ERROR_CODE_TO_HTTP_STATUS, HTTP_STATUS } = require('../constants/errorCodes');
const ErrorLogger = require('./errorLogger');
const { InvalidIdError, DuplicateKeyError, RecordValidationError, duplicateKeyFields } = require('../data/errors');
const { translateWriteError } = require('../data');

class AppError extends Error {
	constructor(errorCode, message, statusCode, details = {}, isOperational = true) {
		super(message);
		this.errorCode = errorCode;
		this.statusCode = statusCode;
		this.details = details;
		this.isOperational = isOperational;
		this.timestamp = new Date().toISOString();
		Error.captureStackTrace(this, this.constructor);
	}
}

class ErrorResponse {
	static createError(errorCode, customMessage = null, details = {}) {
		const defaultMessage = ERROR_MESSAGES[errorCode]?.vi || ERROR_MESSAGES[ERROR_CODES.INTERNAL_SERVER_ERROR].vi;
		const statusCode = ERROR_CODE_TO_HTTP_STATUS[errorCode] || HTTP_STATUS.INTERNAL_SERVER_ERROR;

		return new AppError(
			errorCode,
			customMessage || defaultMessage,
			statusCode,
			details,
			true
		);
	}

	static validationError(message, details = {}) {
		return this.createError(ERROR_CODES.VALIDATION_ERROR, message, details);
	}

	static notFoundError(resource, details = {}) {
		return this.createError(
			ERROR_CODES.NOT_FOUND,
			`${resource} không tìm thấy`,
			details
		);
	}

	static unauthorizedError(message = null, details = {}) {
		return this.createError(ERROR_CODES.UNAUTHORIZED, message, details);
	}

	static forbiddenError(message = null, details = {}) {
		return this.createError(ERROR_CODES.FORBIDDEN, message, details);
	}

	static conflictError(message, details = {}) {
		return this.createError(ERROR_CODES.CONFLICT, message, details);
	}

	static databaseError(message = null, details = {}) {
		return this.createError(ERROR_CODES.DATABASE_ERROR, message, details);
	}

	static externalServiceError(serviceName, details = {}) {
		return this.createError(
			ERROR_CODES.EXTERNAL_SERVICE_ERROR,
			`Lỗi kết nối với ${serviceName}`,
			details
		);
	}

	static badRequestError(message, details = {}) {
		return this.createError(ERROR_CODES.BAD_REQUEST, message, details);
	}

	static productUnavailableError(productName, details = {}) {
		return this.createError(
			ERROR_CODES.PRODUCT_UNAVAILABLE,
			`Sản phẩm "${productName}" không khả dụng`,
			details
		);
	}

	static orderProcessingError(message, details = {}) {
		return this.createError(ERROR_CODES.ORDER_PROCESSING_ERROR, message, details);
	}

	static comboError(message, details = {}) {
		return this.createError(ERROR_CODES.COMBO_ERROR, message, details);
	}

	static formatErrorResponse(error, req, includeStack = false) {
		const isProduction = process.env.NODE_ENV === 'production';
		const isDevelopment = process.env.NODE_ENV === 'development';

		const response = {
			success: false,
			error: {
				code: error.errorCode || ERROR_CODES.INTERNAL_SERVER_ERROR,
				message: error.message || ERROR_MESSAGES[ERROR_CODES.INTERNAL_SERVER_ERROR].vi,
				timestamp: error.timestamp || new Date().toISOString()
			}
		};

		// `details` can carry internal context meant for logs, not clients — the
		// CORS handler in server.js attaches { allowedOrigins } to it, for one.
		// Only forward it outside production, same as the debug block below.
		if (!isProduction && error.details && Object.keys(error.details).length > 0) {
			response.error.details = error.details;
		}

		if (isDevelopment || includeStack) {
			response.error.debug = {
				stack: error.stack,
				name: error.name,
				statusCode: error.statusCode,
				isOperational: error.isOperational,
				request: {
					method: req.method,
					url: req.originalUrl || req.url,
					params: req.params,
					query: req.query,
					body: ErrorLogger.sanitizeBody(req.body)
				}
			};
		}

		if (!isProduction && req.user) {
			response.error.debug = response.error.debug || {};
			response.error.debug.userId = req.user.id;
		}

		return response;
	}

	static sendErrorResponse(res, error, req) {
		const statusCode = error.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
		const response = this.formatErrorResponse(error, req);

		ErrorLogger.logRoute(req.route?.path || req.path || 'unknown', error, req);

		res.status(statusCode).json(response);
	}

	static async handleAsync(fn) {
		return async (req, res, next) => {
			try {
				await fn(req, res, next);
			} catch (error) {
				next(error);
			}
		};
	}
}

/**
 * True for a failed write the repositories report (or, for code not yet behind a
 * repository, a Prisma error that `translateWriteError` turns into one of them).
 */
function isDataError(error) {
	return error instanceof RecordValidationError
		|| error instanceof InvalidIdError
		|| error instanceof DuplicateKeyError
		|| translateWriteError(error) !== error;
}

function handleDataError(raw) {
	// Routes still reading the store directly raise its own errors; one
	// translation here gives both kinds the same answer.
	const error = translateWriteError(raw);

	if (error instanceof RecordValidationError) {
		return ErrorResponse.validationError('Dữ liệu không hợp lệ', { errors: error.fieldErrors });
	}

	if (error instanceof InvalidIdError) {
		return ErrorResponse.badRequestError(`ID không hợp lệ: ${error.value}`);
	}

	if (error instanceof DuplicateKeyError) {
		const field = error.fields[0] || duplicateKeyFields(error);
		return ErrorResponse.conflictError(`${field} đã tồn tại`, { field });
	}

	// Fallback: an unrecognised driver/connection error. Its raw `.message` can
	// contain internal detail (connection strings, index names, field values)
	// that must never reach a client — log it and answer with the generic
	// message instead. `undefined` here falls through to ErrorResponse's own
	// default DATABASE_ERROR message.
	ErrorLogger.logDatabase('unhandled', error);
	return ErrorResponse.databaseError(
		process.env.NODE_ENV === 'production' ? undefined : error.message,
		{ originalError: error.name }
	);
}

module.exports = {
	ErrorResponse,
	isDataError,
	handleDataError
};
