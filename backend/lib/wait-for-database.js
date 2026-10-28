const { connectDB } = require('./database');

const DATABASE_LABEL = 'PostgreSQL';

/**
 * Connects, retrying while the database is not ready: still starting, or (on
 * PostgreSQL) a release step that has not finished its migrations yet. The last
 * failure is part of the final error so the log names what the wait ran into,
 * for example the pending migrations.
 */
async function waitForDatabase({ connect = connectDB, maxRetries = 30, delayMs = 2000 } = {}) {
	console.log(`Waiting for ${DATABASE_LABEL} to be ready...`);
	let lastError = null;

	for (let retries = 1; retries <= maxRetries; retries++) {
		try {
			await connect();
			console.log(`[OK] ${DATABASE_LABEL} is ready`);
			return true;
		} catch (error) {
			lastError = error;
			console.log(`${DATABASE_LABEL} not ready, retrying... (${retries}/${maxRetries})`);
			if (retries < maxRetries) await new Promise(resolve => setTimeout(resolve, delayMs));
		}
	}

	// The message is redacted where it is logged (ErrorLogger), not here.
	throw new Error(
		`${DATABASE_LABEL} failed to become ready within timeout` +
		(lastError ? `: ${lastError.message}` : ''),
		{ cause: lastError }
	);
}

module.exports = { waitForDatabase };
