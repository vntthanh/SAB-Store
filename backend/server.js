require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const { auth, getAllowedOrigins } = require('./lib/auth');
const { connectDB } = require('./lib/database');
const { toNodeHandler } = require('better-auth/node');
const ErrorLogger = require('./utils/errorLogger');
const { ErrorResponse, handleMongooseError } = require('./utils/errorResponse');
const { ERROR_CODES, HTTP_STATUS } = require('./constants/errorCodes');
const { requestLogger, errorRateLimiter, healthCheckEndpoint } = require('./middleware/logger');
const { setupProcessMonitoring } = require('./utils/performanceMonitor');

// Mirror the allowed origin back on a response. Used by the pass-through
// middleware, the error handler and the 404 handler alike. getAllowedOrigins()
// (lib/auth.js) is the single source of truth for every allowlist in this
// process — no domain is hardcoded here, and it reads CORS_ORIGIN fresh on
// every call so tests can change it at runtime.
function applyCorsHeaders(req, res) {
	const origin = req.headers.origin;
	// Always vary on Origin, even when no CORS header is set below, so shared
	// caches never serve one origin's response to another.
	res.header('Vary', 'Origin');
	if (origin && getAllowedOrigins().includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin);
		res.header('Access-Control-Allow-Credentials', 'true');
		res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
		res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, X-Requested-With');
	}
}

/**
 * Build the fully wired Express app.
 *
 * Exported so tests exercise the same middleware stack production runs —
 * mounting the routers alone would skip the auth guards and body limits that
 * are applied here, and would test an app that does not exist.
 */
function createApp() {
	const app = express();

	// Trust proxy configuration - secure setup for rate limiting.
	// Requests arrive through two hops (NPM -> frontend nginx -> backend), so
	// trusting a single proxy would make req.ip the frontend container for every
	// visitor and collapse all rate limiting onto one bucket.
	app.set('trust proxy', process.env.NODE_ENV === 'production' ? 2 : false);

	// Parse query strings into plain strings only. Express' default parser turns
	// ?status[$ne]= into a nested object that reaches Mongo as a live operator.
	app.set('query parser', 'simple');

	// Security middleware
	app.use(helmet({
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				connectSrc: [
					"'self'",
					...getAllowedOrigins(),
					"https://fonts.googleapis.com",
					"https://fonts.gstatic.com",
					"https://cdnjs.cloudflare.com"
				],
				// No inline <script> ships in frontend/index.html (Vite emits only
				// hashed external bundles) and nothing in frontend/src or its
				// dependencies calls eval()/new Function(), so neither directive is
				// needed. If a future dependency needs eval, add 'unsafe-eval' back
				// deliberately rather than restoring both.
				scriptSrc: ["'self'"],
				styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
				fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
				imgSrc: ["'self'", "data:", "blob:", "https:"],
				manifestSrc: ["'self'"],
				objectSrc: ["'none'"],
				baseUri: ["'self'"],
				formAction: ["'self'"],
				frameAncestors: ["'none'"],
				upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
			}
		}
	}));
	app.use(compression());

	// CORS configuration - Must be before Better Auth handler
	const corsOptions = {
		origin: function (origin, callback) {
			// Allow requests with no origin (like mobile apps or curl requests)
			if (!origin) return callback(null, true);

			if (getAllowedOrigins().includes(origin)) {
				return callback(null, true);
			}

			console.warn(`[CORS] Blocked origin: ${origin}`);
			callback(new Error(`Not allowed by CORS: ${origin}`));
		},
		credentials: true,
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Requested-With'],
		exposedHeaders: ['Set-Cookie'],
		preflightContinue: false,
		optionsSuccessStatus: 200
	};

	app.use(cors(corsOptions));

	// Deliberately no explicit wildcard OPTIONS handler here: cors() above
	// already answers preflight requests (preflightContinue: false). A
	// hand-rolled one after it would be dead code today, but if these two
	// lines were ever reordered it would become a second, un-allowlisted CORS
	// implementation that mirrors any Origin back with credentials — a bypass
	// of the allowlist above.

	// Body parsing middleware - Must be BEFORE Better Auth handler.
	// 1mb covers every JSON/form payload the API accepts; uploads go through
	// multer (routes/upload.js), never through this parser.
	app.use(express.json({ limit: '1mb' }));
	app.use(express.urlencoded({ extended: true, limit: '1mb' }));

	// Request logging middleware
	app.use(requestLogger);

	// Global CORS headers middleware for all responses
	app.use((req, res, next) => {
		applyCorsHeaders(req, res);
		next();
	});

	// Rate limiting is OFF by default. `trust proxy` above is set to 2 hops for
	// production, but that hop count has never been verified against real
	// traffic (two requests from two different source IPs must resolve to two
	// different req.ip values). Enabling this with a wrong hop count collapses
	// every visitor onto one bucket and 429s the entire site. Flip
	// RATE_LIMIT_ENABLED=true only after that check has been run in prod.
	if (process.env.RATE_LIMIT_ENABLED === 'true') {
		const rateLimit = require('express-rate-limit');
		const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
		const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
		const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

		app.use('/api/auth', authLimiter);
		// Also covers GET /api/orders/:orderCode: a public order-tracking code
		// has only 9,000 possible values, so the read path needs the same limit
		// as order creation, not just the write path.
		app.use('/api/orders', orderLimiter);
		app.use('/api', publicLimiter);
	}

	// Better-auth API routes - Must be AFTER body parsing middleware
	app.all('/api/auth/*', toNodeHandler(auth));

	// Routes
	// Upload writes to and deletes from object storage. Only the admin product UI
	// uses it, so it must never be reachable without an admin session.
	const { authenticateAdmin } = require('./middleware/better-auth');
	app.use('/api/upload', authenticateAdmin, require('./routes/upload'));
	app.use('/api/products', require('./routes/products'));
	app.use('/api/orders', require('./routes/orders'));
	app.use('/api/combos', require('./routes/combos'));
	// /api/admin/settings must be mounted before the broader /api/admin: both
	// routers call authenticateAdmin at their own top, and admin.js has no
	// route matching "/settings" — so with the broad mount first, a settings
	// request runs authenticateAdmin once in admin.js, falls through with no
	// match, and runs it again in settings.js. Mounting the specific path
	// first lets settings.js fully handle the request in one auth check.
	app.use('/api/admin/settings', require('./routes/admin/settings'));
	app.use('/api/admin', require('./routes/admin'));
	app.use('/api/seller', require('./routes/seller'));

	// Health check with detailed metrics
	app.get('/health', healthCheckEndpoint);

	// Error rate limiting middleware
	app.use(errorRateLimiter());

	// Error handling middleware
	app.use((err, req, res, next) => {
		applyCorsHeaders(req, res);
		const origin = req.headers.origin;

		if (err.name === 'CORSError' || err.message?.includes('CORS')) {
			const corsError = ErrorResponse.createError(
				ERROR_CODES.CORS_ERROR,
				`CORS policy blocked request from origin: ${origin}`,
				{ origin, allowedOrigins: getAllowedOrigins() }
			);
			return ErrorResponse.sendErrorResponse(res, corsError, req);
		}

		let error = err;

		if (err.name === 'ValidationError' || err.name === 'CastError' || err.code === 11000) {
			error = handleMongooseError(err);
		}

		if (!error.errorCode) {
			error = ErrorResponse.createError(
				ERROR_CODES.INTERNAL_SERVER_ERROR,
				process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
				{
					originalError: err.name,
					isOperational: false
				}
			);
			error.statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR;
			error.stack = err.stack;
		}

		ErrorResponse.sendErrorResponse(res, error, req);
	});

	// 404 handler
	app.use('*', (req, res) => {
		applyCorsHeaders(req, res);

		const error = ErrorResponse.notFoundError('Route', {
			method: req.method,
			url: req.originalUrl || req.url
		});

		ErrorLogger.logWarning('404 - Route not found', {
			method: req.method,
			url: req.originalUrl || req.url,
			ip: req.ip
		});

		res.status(HTTP_STATUS.NOT_FOUND).json(ErrorResponse.formatErrorResponse(error, req));
	});

	return app;
}

const PORT = process.env.PORT || 5000;

let server;

// Start server with database connection
async function startServer() {
	try {
		await connectDB();

		setupProcessMonitoring();

		const app = createApp();

		server = app.listen(PORT, () => {
			ErrorLogger.logInfo('[SERVER] Server running', {
				port: PORT,
				env: process.env.NODE_ENV,
				apiUrl: `http://localhost:${PORT}/api`,
				monitoring: 'enabled'
			});
		});

		server.on('error', (error) => {
			// This is a socket-level event with no HTTP request in scope.
			// logRoute() expects a real Express req — it calls req.get(...) — so
			// the object literal previously passed here threw inside this handler
			// and swallowed the real diagnostic (including EADDRINUSE, the most
			// common cause). logCritical() takes (message, error, context) and
			// needs no req.
			if (error.code === 'EADDRINUSE') {
				ErrorLogger.logCritical(`Port ${PORT} is already in use`, error, { port: PORT });
			} else {
				ErrorLogger.logCritical('Server socket error', error, { port: PORT });
			}
			process.exit(1);
		});

	} catch (error) {
		ErrorLogger.logCritical('Server failed to start', error, {
			stage: 'initialization',
			port: PORT
		});
		process.exit(1);
	}
}

// Graceful shutdown handler
async function gracefulShutdown(signal) {
	ErrorLogger.logShutdown(signal, {
		activeConnections: server ? server._connections : 0
	});

	if (server) {
		server.close(async () => {
			ErrorLogger.logInfo('HTTP server closed successfully');

			try {
				const { closeDB } = require('./lib/database');
				await closeDB();
				ErrorLogger.logInfo('Database connection closed successfully');
			} catch (error) {
				ErrorLogger.logWarning('Error closing database connection', {
					error: error.message
				});
			}

			ErrorLogger.logInfo('Graceful shutdown completed');
			process.exit(0);
		});

		setTimeout(() => {
			ErrorLogger.logCritical('Forced shutdown after 10s timeout',
				new Error('Shutdown timeout'),
				{ signal }
			);
			process.exit(1);
		}, 10000);
	} else {
		ErrorLogger.logInfo('No active server to close, exiting immediately');
		process.exit(0);
	}
}

// Process-level wiring, registered only when this file runs as the entry point.
// Tests import createApp() instead, and must not inherit handlers that call
// process.exit() or swallow the failures the test runner needs to see.
function registerProcessHandlers() {
	// Handle graceful shutdown signals
	process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
	process.on('SIGINT', () => gracefulShutdown('SIGINT'));

	// Handle uncaught exceptions. Always shut down: reaching this handler means
	// the error escaped every try/catch and the Express error middleware, so
	// the process is in an unknown state regardless of the error's own
	// isOperational flag. The previous `if (!error.isOperational)` guard was a
	// near-permanent no-op — AppError (utils/errorResponse.js) defaults
	// isOperational to true, and only AppError instances set it at all.
	process.on('uncaughtException', (error) => {
		ErrorLogger.logUncaughtException(error, 'uncaughtException');
		ErrorLogger.logCritical('Uncaught exception, initiating shutdown', error);
		gracefulShutdown('uncaughtException');
	});

	// Handle unhandled promise rejections
	process.on('unhandledRejection', (reason, promise) => {
		ErrorLogger.logUnhandledRejection(reason, promise);

		if (process.env.NODE_ENV === 'production') {
			ErrorLogger.logCritical('Unhandled rejection in production, initiating shutdown',
				reason instanceof Error ? reason : new Error(String(reason))
			);
			gracefulShutdown('unhandledRejection');
		}
	});

	// Handle process warnings
	process.on('warning', (warning) => {
		ErrorLogger.logWarning('Process warning detected', {
			name: warning.name,
			message: warning.message,
			stack: warning.stack
		});
	});
}

module.exports = { createApp, startServer };

// Production runs `yarn start` -> start.js -> spawn('node', ['server.js']), so
// this file is still the entry point of its own process.
if (require.main === module) {
	registerProcessHandlers();
	startServer();
}
