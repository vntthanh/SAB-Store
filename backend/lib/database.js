require('dotenv').config({ quiet: true });
const ErrorLogger = require('../utils/errorLogger');
const { backendName } = require('../data/backend-name');

const POSTGRES = backendName === 'postgres';

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
	// mongo process must never open one.
	const { prisma } = require('./prisma');
	await prisma.$connect();
	await prisma.$queryRaw`SELECT 1`;
	await require('./require-migrations').requireMigrationsApplied(prisma);

	isConnected = true;
	ErrorLogger.logInfo('[OK] PostgreSQL connected successfully via Prisma');
}

async function connectMongo() {
	const mongoUri = process.env.MONGODB_URI;
	if (!mongoUri) {
		const error = new Error('MONGODB_URI environment variable is required');
		ErrorLogger.logDatabase('connect', error, { step: 'validation' });
		throw error;
	}

	ErrorLogger.logInfo('Connecting to MongoDB...', {
		host: mongoUri.split('@')[1]?.split('/')[0] || 'unknown'
	});

	const mongoose = require('mongoose');
	await mongoose.connect(mongoUri);
	await require('./require-replica-set').requireReplicaSet(mongoose.connection);

	isConnected = true;
	ErrorLogger.logInfo('[OK] MongoDB connected successfully via Mongoose', {
		readyState: mongoose.connection.readyState
	});

	mongoose.connection.on('error', (err) => {
		ErrorLogger.logDatabase('connection_error', err, {
			readyState: mongoose.connection.readyState
		});
		isConnected = false;
	});

	mongoose.connection.on('disconnected', () => {
		ErrorLogger.logWarning('MongoDB disconnected', {
			readyState: mongoose.connection.readyState
		});
		isConnected = false;
	});

	mongoose.connection.on('reconnected', () => {
		ErrorLogger.logInfo('MongoDB reconnected', {
			readyState: mongoose.connection.readyState
		});
		isConnected = true;
	});
}

/** Connects the store `DATA_BACKEND` selects; on postgres also refuses an unmigrated schema. */
async function connectDB() {
	if (isConnected) {
		ErrorLogger.logInfo(`${POSTGRES ? 'PostgreSQL' : 'MongoDB'} already connected`);
		return;
	}

	try {
		await (POSTGRES ? connectPostgres() : connectMongo());
	} catch (error) {
		ErrorLogger.logDatabase('connect', error, { step: 'connection' });
		isConnected = false;
		throw error;
	}
}

async function closeDB() {
	if (!POSTGRES) await require('mongoose').connection.close();
	// The Prisma pool exists once lib/prisma has been required. Looking it up in the
	// module cache avoids opening a pool just to close it; a pool left open keeps a
	// script alive until its idle timeout.
	const loaded = require.cache[require.resolve('./prisma')];
	if (loaded) await loaded.exports.closeDb();
	isConnected = false;
}

module.exports = { connectDB, closeDB };
