/**
 * Preflight environment check.
 *
 * Referenced by `yarn debug`, which previously failed outright because this
 * file did not exist. Reports which variables are set and which are missing
 * WITHOUT printing any value: this runs on a shared host and its output ends up
 * in logs and pasted into chats.
 */
require('dotenv').config({ quiet: true });
const { backendName } = require('./data/backend-name');

// The store DATA_BACKEND selects decides which connection string is needed.
const DATABASE_VARIABLE = backendName === 'postgres' ? 'DATABASE_URL' : 'MONGODB_URI';

// Missing any of these means the process cannot serve traffic correctly.
const REQUIRED = [
	DATABASE_VARIABLE,
	'JWT_SECRET',
	'CORS_ORIGIN',
	// The storage container refuses default or short keys, so there is no
	// working fallback for these.
	'MINIO_ACCESS_KEY',
	'MINIO_SECRET_KEY',
];

// Absent values fall back to a working default, so they are reported but not fatal.
const OPTIONAL = [
	'DATA_BACKEND',
	'NODE_ENV',
	'PORT',
	'BASE_URL',
	'INIT_EMPTY_DATABASE',
	// Read only to create the first admin in an empty database.
	'ADMIN_EMAIL',
	'ADMIN_USERNAME',
	'ADMIN_PASSWORD',
	'MINIO_ENDPOINT',
	'MINIO_PORT',
	'MINIO_BUCKET_NAME',
	'MINIO_USE_SSL',
	// Google One Tap is offered only when this is set; unset hides the button.
	'GOOGLE_CLIENT_ID',
	'TZ',
];

// Names whose values must never be echoed, even in truncated form.
const SECRET = /SECRET|PASSWORD|KEY|URI|TOKEN|^DATABASE_URL$/i;

function describe(name) {
	const value = process.env[name];
	if (!value) return 'MISSING';
	if (SECRET.test(name)) return `set (${value.length} chars)`;
	return `set (${value})`;
}

const missing = REQUIRED.filter((name) => !process.env[name]);

console.log('Required:');
for (const name of REQUIRED) console.log(`  ${name}: ${describe(name)}`);

console.log('Optional:');
for (const name of OPTIONAL) console.log(`  ${name}: ${describe(name)}`);

// Catch the two mistakes that boot a working-looking server with a known key.
const jwt = process.env.JWT_SECRET;
const problems = [];
if (jwt && jwt.length < 32) problems.push('JWT_SECRET is shorter than 32 characters');
if (jwt && /change-this|your-super-secret|secret-key-here|changeme/i.test(jwt)) {
	problems.push('JWT_SECRET is still a placeholder value');
}

// A wrong client id does not fail at boot: Google would reject every token at
// sign-in time, so a typo is caught here instead.
const googleClientId = process.env.GOOGLE_CLIENT_ID;
if (googleClientId && !googleClientId.endsWith('.apps.googleusercontent.com')) {
	problems.push('GOOGLE_CLIENT_ID must end with .apps.googleusercontent.com');
}

if (missing.length) problems.push(`missing required: ${missing.join(', ')}`);

if (problems.length) {
	console.error('\nFAILED:');
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

console.log('\nOK: environment satisfies the required checks');
