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

async function waitForMinIO() {
	console.log('Waiting for MinIO to be ready...');
	const maxRetries = 30;
	let retries = 0;

	while (retries < maxRetries) {
		try {
			await initializeBucket();
			console.log('[OK] MinIO is ready and bucket initialized');
			return true;
		} catch (error) {
			retries++;
			console.log(`MinIO not ready, retrying... (${retries}/${maxRetries})`);
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
	}

	throw new Error('MinIO failed to become ready within timeout');
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
		await waitForMinIO();
		await initializeDatabase();
		await startServer();
	} catch (error) {
		console.error('[ERROR] Startup failed:', error);
		console.error('Stack:', error.stack);
		process.exit(1);
	}
}

main();
