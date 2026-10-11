// Read by the Prisma CLI (generate, migrate). The URL falls back to an address
// that can never resolve (.invalid is reserved), so `prisma generate` works where
// no database exists, while a migrate run without DATABASE_URL fails instead of
// reaching a local Postgres that trusts every connection.
require('dotenv').config({ quiet: true });
const { defineConfig } = require('prisma/config');

module.exports = defineConfig({
	schema: 'prisma/schema',
	migrations: { path: 'prisma/migrations' },
	datasource: {
		url: process.env.DATABASE_URL || 'postgresql://unset:unset@invalid.invalid:5432/unset',
	},
});
