require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const { auth } = require('./lib/auth');
const { connectDB } = require('./lib/database');
const { toNodeHandler } = require('better-auth/node');
const ErrorLogger = require('./utils/errorLogger');
const { ErrorResponse, handleMongooseError } = require('./utils/errorResponse');
const { ERROR_CODES, HTTP_STATUS } = require('./constants/errorCodes');
const { requestLogger, errorRateLimiter, healthCheckEndpoint } = require('./middleware/logger');
const { setupProcessMonitoring } = require('./utils/performanceMonitor');

const app = express();

// Trust proxy configuration - secure setup for rate limiting
// Only trust first proxy (recommended for most deployments)
// Set to false if not behind a proxy, or configure specific trusted IPs
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);

// Security middleware
app.use(helmet({
	contentSecurityPolicy: {
		directives: {
			defaultSrc: ["'self'"],
			connectSrc: [
				"'self'",
				"https://api.store.sab.edu.vn",
				"https://api.lanyard.sab.edu.vn",
				"https://store.sab.edu.vn",
				"https://fonts.googleapis.com",
				"https://fonts.gstatic.com",
				"https://cdnjs.cloudflare.com"
			],
			scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
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

		// Support multiple origins from environment variable (comma-separated)
		const allowedOrigins = [
			...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
			'http://store.sab.edu.vn',
			'https://store.sab.edu.vn',
			'https://api.store.sab.edu.vn',
			'https://lanyard.sab.edu.vn',
			'https://api.lanyard.sab.edu.vn',
			'http://localhost:3000', // Development
			'http://127.0.0.1:3000'  // Development
		];

		if (allowedOrigins.includes(origin)) {
			return callback(null, true);
		}

		console.warn(`[CORS] Blocked origin: ${origin}`);
		callback(new Error('Not allowed by CORS ${origin}}'));
	},
	credentials: true,
	methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Requested-With'],
	exposedHeaders: ['Set-Cookie'],
	preflightContinue: false,
	optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Handle preflight OPTIONS requests explicitly
app.options('*', (req, res) => {
	res.header('Access-Control-Allow-Origin', req.headers.origin);
	res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, X-Requested-With');
	res.header('Access-Control-Allow-Credentials', 'true');
	res.sendStatus(200);
});

// Body parsing middleware - Must be BEFORE Better Auth handler
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Request logging middleware
app.use(requestLogger);

// Global CORS headers middleware for all responses
app.use((req, res, next) => {
	const allowedOrigins = [
		...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
		'https://store.sab.edu.vn',
		'https://api.store.sab.edu.vn',
		'http://localhost:3000',
		'http://127.0.0.1:3000'
	];

	const origin = req.headers.origin;
	if (!origin || allowedOrigins.includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin || '*');
		res.header('Access-Control-Allow-Credentials', 'true');
		res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
		res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, X-Requested-With');
	}

	next();
});

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
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/settings', require('./routes/admin/settings'));
app.use('/api/seller', require('./routes/seller'));

// Health check with detailed metrics
app.get('/health', healthCheckEndpoint);

// Error rate limiting middleware
app.use(errorRateLimiter());

// Error handling middleware
app.use((err, req, res, next) => {
	const allowedOrigins = [
		...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
		'https://store.sab.edu.vn',
		'https://api.store.sab.edu.vn',
		'http://localhost:3000',
		'http://127.0.0.1:3000'
	];

	const origin = req.headers.origin;
	if (!origin || allowedOrigins.includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin || '*');
		res.header('Access-Control-Allow-Credentials', 'true');
		res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
		res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, X-Requested-With');
	}

	if (err.name === 'CORSError' || err.message?.includes('CORS')) {
		const corsError = ErrorResponse.createError(
			ERROR_CODES.CORS_ERROR,
			`CORS policy blocked request from origin: ${origin}`,
			{ origin, allowedOrigins }
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
	const allowedOrigins = [
		...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
		'https://store.sab.edu.vn',
		'https://api.store.sab.edu.vn',
		'http://localhost:3000',
		'http://127.0.0.1:3000'
	];

	const origin = req.headers.origin;
	if (!origin || allowedOrigins.includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin || '*');
		res.header('Access-Control-Allow-Credentials', 'true');
		res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
		res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie, X-Requested-With');
	}

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

const PORT = process.env.PORT || 5000;

let server;

// Start server with database connection
async function startServer() {
	try {
		await connectDB();

		setupProcessMonitoring();

		server = app.listen(PORT, () => {
			ErrorLogger.logInfo('[SERVER] Server running', {
				port: PORT,
				env: process.env.NODE_ENV,
				apiUrl: `http://localhost:${PORT}/api`,
				monitoring: 'enabled'
			});
		});

		server.on('error', (error) => {
			if (error.code === 'EADDRINUSE') {
				ErrorLogger.logRoute('server', error, {
					message: `Port ${PORT} is already in use`,
					port: PORT
				});
			} else {
				ErrorLogger.logRoute('server', error, { port: PORT });
			}
			process.exit(1);
		});

	} catch (error) {
		ErrorLogger.logRoute('startServer', error, {
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

// Handle graceful shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
	ErrorLogger.logUncaughtException(error, 'uncaughtException');

	if (!error.isOperational) {
		ErrorLogger.logCritical('Non-operational error detected, initiating shutdown', error);
		gracefulShutdown('uncaughtException');
	}
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

startServer();
