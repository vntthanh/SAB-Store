require('dotenv').config({ quiet: true });
const ErrorLogger = require('../utils/errorLogger');
let isConnected = false;

// Host and port only. The connection string carries the password, and Prisma and
// pg errors can quote it, so nothing but this is ever logged about the target.
function postgresHost(databaseUrl) {
	try {
		return new URL(databaseUrl).host || 'unknown';
	} catch {
		return 'unknown';
	}
}

async function connectPostgres() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		const error = new Error('DATABASE_URL environment variable is required');
		ErrorLogger.logDatabase('connect', error, { step: 'validation' });
		throw error;
	}

	ErrorLogger.logInfo('Connecting to PostgreSQL...', { host: postgresHost(databaseUrl) });

	// Required here, not at the top: lib/prisma.js builds the pool on load, and a
	// script that only reads this module's exports must not open one.
	const { prisma } = require('./prisma');
	await prisma.$connect();
	await prisma.$queryRaw`SELECT 1`;
	await require('./require-migrations').requireMigrationsApplied(prisma);

	isConnected = true;
	ErrorLogger.logInfo('[OK] PostgreSQL connected successfully via Prisma');
}

/** Connects to PostgreSQL and refuses an unmigrated schema. */
async function connectDB() {
	if (isConnected) {
		ErrorLogger.logInfo('PostgreSQL already connected');
		return;
	}

	try {
		await connectPostgres();
	} catch (error) {
		ErrorLogger.logDatabase('connect', error, { step: 'connection' });
		isConnected = false;
		throw error;
	}
}

async function closeDB() {
	// The Prisma pool exists once lib/prisma has been required. Looking it up in the
	// module cache avoids opening a pool just to close it; a pool left open keeps a
	// script alive until its idle timeout.
	const loaded = require.cache[require.resolve('./prisma')];
	if (loaded) await loaded.exports.closeDb();
	isConnected = false;
}

module.exports = { connectDB, closeDB };
