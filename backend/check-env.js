/**
 * Preflight environment check.
 *
 * Referenced by `yarn debug`, which previously failed outright because this
 * file did not exist. Reports which variables are set and which are missing
 * WITHOUT printing any value: this runs on a shared host and its output ends up
 * in logs and pasted into chats.
 */
require('dotenv').config();

// Missing any of these means the process cannot serve traffic correctly.
const REQUIRED = [
	'MONGODB_URI',
	'JWT_SECRET',
	'ADMIN_EMAIL',
	'ADMIN_USERNAME',
	'ADMIN_PASSWORD',
	'CORS_ORIGIN',
];

// Absent values fall back to a working default, so they are reported but not fatal.
const OPTIONAL = [
	'NODE_ENV',
	'PORT',
	'BASE_URL',
	'APPSCRIPT_URL',
	'MINIO_ENDPOINT',
	'MINIO_PORT',
	'MINIO_ACCESS_KEY',
	'MINIO_SECRET_KEY',
	'MINIO_BUCKET_NAME',
	'MINIO_USE_SSL',
	'TZ',
];

// Names whose values must never be echoed, even in truncated form.
const SECRET = /SECRET|PASSWORD|KEY|URI|TOKEN/i;

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

if (missing.length) problems.push(`missing required: ${missing.join(', ')}`);

if (problems.length) {
	console.error('\nFAILED:');
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

console.log('\nOK: environment satisfies the required checks');
