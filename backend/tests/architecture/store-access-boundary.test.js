const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '../..');

// Code that must reach the store through `backend/data`. `lib` and `data` are
// scanned too so the allowlist below has teeth: it names the only files in them
// that may touch the storage engine.
const SCANNED = ['routes', 'services', 'utils', 'middleware', 'queues', 'scripts', 'lib', 'data', 'init-database.js'];

// The Prisma client itself, the connection and health check, the auth library's
// own adapter, and the repositories.
const ALLOWED = [
	'lib/prisma.js',
	'lib/database.js',
	'lib/auth.js',
	'data/',
];

const REQUIRE = /require\(\s*(['"`])([^'"`]+)\1\s*\)/g;

function touchesStorageEngine(specifier) {
	return /^pg(\/|$)/.test(specifier)
		|| /^@prisma\//.test(specifier)
		|| /(^|\/)prisma(\/|$)/.test(specifier)
		|| /(^|\/)generated(\/|$)/.test(specifier);
}

function sourceFiles(entry) {
	const full = path.join(BACKEND, entry);
	if (!fs.existsSync(full)) return [];
	if (fs.statSync(full).isFile()) return [entry];
	return fs.readdirSync(full, { withFileTypes: true }).flatMap((child) => {
		const relative = `${entry}/${child.name}`;
		if (child.isDirectory()) return sourceFiles(relative);
		return child.name.endsWith('.js') ? [relative] : [];
	});
}

// Block comments are blanked (newlines kept, so line numbers hold) and `//`
// comments dropped, so a comment never counts but code beside one does.
// A `//` inside a string such as 'http://x' is only cut after the require, which
// is harmless for this scan.
function withoutComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
		.split('\n')
		.map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'));
}

function violationsIn(file, source) {
	const found = [];
	withoutComments(source).forEach((line, index) => {
		for (const [, , specifier] of line.matchAll(REQUIRE)) {
			if (touchesStorageEngine(specifier)) found.push(`${file}:${index + 1}  require('${specifier}')`);
		}
	});
	return found;
}

function isAllowed(file) {
	return ALLOWED.some((allowed) => file === allowed || (allowed.endsWith('/') && file.startsWith(allowed)));
}

// Out of scope: a `require(variable)` and ESM `import` cannot be matched by text
// (the backend is CommonJS). The one dynamic require today is
// scripts/bench-pricing.js:96, which loads the combo optimizer under test and
// never the database client.
function violations() {
	return SCANNED.flatMap(sourceFiles)
		.filter((file) => !isAllowed(file))
		.flatMap((file) => violationsIn(file, fs.readFileSync(path.join(BACKEND, file), 'utf8')));
}

describe('store access boundary', () => {
	it('keeps the Prisma client and the database driver out of routes, services, utils, middleware, queues and scripts', () => {
		const found = violations();

		expect(
			found,
			`These files reach the store directly. Move the query into a repository function under ` +
			`backend/data/postgres, expose it through backend/data/index.js, and call it from the ` +
			`caller (see the header of data/index.js). Only ${ALLOWED.join(', ')} may require the client or the driver.\n` +
			found.join('\n')
		).toEqual([]);
	});

	it('scans every listed entry, so a renamed directory fails here instead of passing empty', () => {
		for (const entry of SCANNED) {
			expect(fs.existsSync(path.join(BACKEND, entry)), `${entry} no longer exists; update SCANNED`).toBe(true);
			expect(sourceFiles(entry).length, `${entry} yields no source file`).toBeGreaterThan(0);
		}
		expect(SCANNED.flatMap(sourceFiles)).toContain('data/postgres/orders.js');
	});

	it('flags the ways a file can reach the store and ignores comments and repositories', () => {
		const flagged = [
			"const { prisma } = require('../lib/prisma');",
			'const { prisma } = require("../lib/prisma");',
			"const { PrismaClient } = require('../generated/prisma/client');",
			"const { PrismaPg } = require('@prisma/adapter-pg');",
			"const { Pool } = require('pg');",
			"const { Client } = require('pg/lib/client');",
			"/* x */ const p = require('../lib/prisma');",
			"const p = require('../lib/prisma'); // fine",
		];
		for (const source of flagged) {
			expect(violationsIn('routes/x.js', source), source).toHaveLength(1);
		}
		const clean = [
			"const { orders } = require('../data');",
			"const helper = require('./model-helpers');",
			"const helper = require('./pg-helpers');",
			"// const p = require('../lib/prisma');",
			"/**\n * require('../lib/prisma')\n */\nconst a = 1;",
		];
		for (const source of clean) {
			expect(violationsIn('routes/x.js', source), source).toEqual([]);
		}
		expect(violationsIn('routes/x.js', "\n\nconst p = require('../lib/prisma');")[0]).toMatch(/^routes\/x\.js:3 /);
		expect(isAllowed('data/postgres/orders.js')).toBe(true);
		expect(isAllowed('lib/auth.js')).toBe(true);
		expect(isAllowed('lib/minio.js')).toBe(false);
	});
});
