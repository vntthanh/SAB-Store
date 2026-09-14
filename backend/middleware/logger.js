const ErrorLogger = require('../utils/errorLogger');
const { monitor } = require('../utils/performanceMonitor');

function requestLogger(req, res, next) {
	const startTime = Date.now();

	const requestInfo = {
		method: req.method,
		url: req.originalUrl || req.url,
		ip: req.ip || req.connection?.remoteAddress,
		userAgent: req.get('user-agent'),
		userId: req.user?.id || 'anonymous'
	};

	res.on('finish', () => {
		const duration = Date.now() - startTime;
		const logData = {
			...requestInfo,
			statusCode: res.statusCode,
			duration: `${duration}ms`
		};

		// The only callers of PerformanceMonitor#recordRequest/recordError in the
		// whole codebase — without this, checkHealth()'s errorRate was always
		// computed as 0/0.
		monitor.recordRequest();
		if (res.statusCode >= 400) {
			monitor.recordError();
		}
		if (duration > 5000) {
			monitor.recordSlowRequest();
		}

		if (res.statusCode >= 500) {
			ErrorLogger.logWarning('Server error response', logData);
		} else if (res.statusCode >= 400) {
			ErrorLogger.logWarning('Client error response', logData);
		} else if (duration > 5000) {
			ErrorLogger.logWarning('Slow request detected', logData);
		} else {
			ErrorLogger.logDebug('Request completed', logData);
		}
	});

	res.on('error', (error) => {
		ErrorLogger.logRoute(req.originalUrl || req.url, error, req);
	});

	next();
}

function errorRateLimiter() {
	const errorCounts = new Map();
	const ERROR_THRESHOLD = 100;
	const TIME_WINDOW = 60000;
	// Hard cap so a burst of distinct IP/error-code pairs (e.g. a botnet
	// spraying different source IPs) cannot grow this Map without bound.
	const MAX_TRACKED_KEYS = 5000;

	// Sweep expired entries on a timer, not only on access — a key that stops
	// erroring is otherwise never touched again and would sit in the Map
	// forever until the size cap started evicting unrelated keys.
	const sweep = setInterval(() => {
		const now = Date.now();
		for (const [key, record] of errorCounts) {
			if (now - record.firstError > TIME_WINDOW) {
				errorCounts.delete(key);
			}
		}
	}, TIME_WINDOW);
	sweep.unref?.();

	return (err, req, res, next) => {
		const key = `${req.ip}-${err.errorCode || 'UNKNOWN'}`;
		const now = Date.now();

		if (!errorCounts.has(key) && errorCounts.size >= MAX_TRACKED_KEYS) {
			// Map iteration order is insertion order — evict the oldest entry
			// rather than let the Map grow past the cap.
			const oldestKey = errorCounts.keys().next().value;
			errorCounts.delete(oldestKey);
		}

		if (!errorCounts.has(key)) {
			errorCounts.set(key, { count: 1, firstError: now });
		} else {
			const record = errorCounts.get(key);

			if (now - record.firstError > TIME_WINDOW) {
				errorCounts.set(key, { count: 1, firstError: now });
			} else {
				record.count++;

				if (record.count > ERROR_THRESHOLD) {
					ErrorLogger.logCritical('Error rate threshold exceeded',
						new Error('High error rate detected'),
						{
							ip: req.ip,
							errorCode: err.errorCode,
							count: record.count,
							timeWindow: TIME_WINDOW
						}
					);
				}
			}
		}

		next(err);
	};
}

function healthCheckEndpoint(req, res) {
	const healthStatus = {
		status: 'OK',
		timestamp: new Date().toISOString(),
		uptime: process.uptime(),
		memory: {
			used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
			total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
			external: Math.round(process.memoryUsage().external / 1024 / 1024)
		},
		cpu: process.cpuUsage(),
		nodeVersion: process.version,
		pid: process.pid
	};

	if (process.memoryUsage().heapUsed / process.memoryUsage().heapTotal > 0.9) {
		healthStatus.warnings = ['High memory usage detected'];
		ErrorLogger.logWarning('High memory usage', healthStatus.memory);
	}

	res.status(200).json(healthStatus);
}

module.exports = {
	requestLogger,
	errorRateLimiter,
	healthCheckEndpoint
};
