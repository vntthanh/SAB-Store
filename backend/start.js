#!/usr/bin/env node

const { spawn } = require('child_process');
const { connectDB } = require('./lib/database');
const { initializeBucket } = require('./lib/minio');

async function waitForMongoDB() {
	console.log('Waiting for MongoDB to be ready...');
	const maxRetries = 30;
	let retries = 0;

	while (retries < maxRetries) {
		try {
			await connectDB();
			console.log('[OK] MongoDB is ready');
			return true;
		} catch (error) {
			retries++;
			console.log(`MongoDB not ready, retrying... (${retries}/${maxRetries})`);
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
	}

	throw new Error('MongoDB failed to become ready within timeout');
}

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
			console.error('[ERROR] Database initialization error:', error);
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
			MONGODB_URI: process.env.MONGODB_URI,
			JWT_SECRET: process.env.JWT_SECRET,
			BASE_URL: process.env.BASE_URL,
			ADMIN_USERNAME: process.env.ADMIN_USERNAME,
			ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
			ADMIN_EMAIL: process.env.ADMIN_EMAIL,
			APPSCRIPT_URL: process.env.APPSCRIPT_URL
		}
	});

	serverProcess.on('error', (error) => {
		console.error('❌ Server start error:', error);
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
process.on('uncaughtException', (error) => {
	console.error('[CRITICAL] Uncaught Exception:', error);
	console.error('Stack:', error.stack);
	console.error('Process will exit...');
	process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
	console.error('[CRITICAL] Unhandled Rejection at:', promise);
	console.error('Reason:', reason);
	console.error('Process will exit...');
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
		await waitForMongoDB();
		await initializeDatabase();
		await startServer();
		ensureStorageInBackground().catch((error) => console.error('[ERROR] Storage initialisation crashed:', error));
	} catch (error) {
		console.error('[ERROR] Startup failed:', error);
		console.error('Stack:', error.stack);
		process.exit(1);
	}
}

main();
