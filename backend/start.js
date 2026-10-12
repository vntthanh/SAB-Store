#!/usr/bin/env node

const { spawn } = require('child_process');
const { waitForDatabase } = require('./lib/wait-for-database');
const ErrorLogger = require('./utils/errorLogger');
const { initializeBucket } = require('./lib/minio');

async function initializeDatabase() {
	console.log('Initializing database...');

	return new Promise((resolve, reject) => {
		const initProcess = spawn('node', ['init-database.js'], {
			stdio: 'inherit',
			env: process.env
		});

		initProcess.on('close', (code) => {
			if (code === 0) {
				console.log('[OK] Database initialized successfully');
				resolve();
			} else {
				// Used to resolve() here, so a failed init (e.g. missing admin
				// credentials) still reported success and the stack came up with
				// no admin account and nobody noticed.
				reject(new Error(`Database initialization failed with exit code ${code}`));
			}
		});

		initProcess.on('error', (error) => {
			ErrorLogger.logCritical('Database initialization error', error, { stage: 'init-database' });
			reject(error);
		});
	});
}

/**
 * Make sure the bucket exists, in the background. The API does not wait for it:
 * a deploy recreates every container at once and object storage is the slowest
 * to start (it added ~30 s to the API outage of one measured deploy), while only
 * uploads need it: product images are served by nginx straight from storage.
 * Until this succeeds an upload fails with a storage error instead of the whole
 * API answering 502. It never gives up: a fresh host has no bucket, and the old
 * blocking start-up recovered by crash-looping, which this must not lose.
 */
async function ensureStorageInBackground() {
	let delayMs = 2000;
	let waitedMs = 0;
	let reported = false;
	for (;;) {
		try {
			await initializeBucket();
			console.log('[OK] Object storage is ready and bucket initialized');
			return;
		} catch (error) {
			if (waitedMs >= 60000 && !reported) {
				console.error('[ERROR] Object storage still unreachable after 60 s; uploads fail until it is back, still retrying');
				reported = true;
			}
			await new Promise(resolve => setTimeout(resolve, delayMs));
			waitedMs += delayMs;
			delayMs = Math.min(delayMs * 2, 60000);
		}
	}
}

async function startServer() {
	console.log('Starting server...');

	const serverProcess = spawn('node', ['server.js'], {
		stdio: 'inherit',
		env: {
			...process.env,  // Spread all environment variables
			// Explicitly pass critical variables
			NODE_ENV: process.env.NODE_ENV,
			CORS_ORIGIN: process.env.CORS_ORIGIN,
			PORT: process.env.PORT,
			DATABASE_URL: process.env.DATABASE_URL,
			MONGODB_URI: process.env.MONGODB_URI,
			JWT_SECRET: process.env.JWT_SECRET,
			BASE_URL: process.env.BASE_URL,
			APPSCRIPT_URL: process.env.APPSCRIPT_URL
		}
	});

	serverProcess.on('error', (error) => {
		ErrorLogger.logCritical('Server start error', error, { stage: 'server-start' });
		process.exit(1);
	});

	serverProcess.on('exit', (code, signal) => {
		console.log(`Server process exited with code ${code} and signal ${signal}`);
		if (code !== 0) {
			console.error('❌ Server exited unexpectedly');
			process.exit(1);
		}
	});

	// Forward signals to server process
	process.on('SIGTERM', () => {
		console.log('Received SIGTERM, shutting down gracefully');
		serverProcess.kill('SIGTERM');
	});
	process.on('SIGINT', () => {
		console.log('Received SIGINT, shutting down gracefully');
		serverProcess.kill('SIGINT');
	});
}

// Handle uncaught exceptions
process.on('uncaughtException', (error, origin) => {
	ErrorLogger.logUncaughtException(error, origin);
	process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
	ErrorLogger.logUnhandledRejection(reason, promise);
	process.exit(1);
});

// Handle process warnings
process.on('warning', (warning) => {
	console.warn('[WARN] Process warning:', {
		name: warning.name,
		message: warning.message,
		stack: warning.stack
	});
});

async function main() {
	try {
		await waitForDatabase();
		await initializeDatabase();
		await startServer();
		ensureStorageInBackground().catch((error) => ErrorLogger.logCritical('Storage initialisation crashed', error, { stage: 'storage' }));
	} catch (error) {
		// Through the logger, not console.error(error): driver errors can quote the
		// connection string, and the logger removes its credentials.
		ErrorLogger.logCritical('Startup failed', error, { stage: 'startup' });
		process.exit(1);
	}
}

main();
