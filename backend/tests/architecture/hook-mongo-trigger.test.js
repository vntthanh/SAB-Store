/**
 * The git hooks run the contract suite on Mongo, the rollback store, when a changed
 * path can break it. The path list lives in both hooks (a hook cannot source another
 * file of this repo's shared lib), so this test keeps the two copies equal, pins which
 * paths trigger the suite, and checks the suite runs after knip and before the backend
 * suite in each hook.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HUSKY = path.resolve(__dirname, '../../../.husky');
const read = (name) => fs.readFileSync(path.join(HUSKY, name), 'utf8');

const BLOCK = /# mongo-contract-paths:begin\n([\s\S]*?)# mongo-contract-paths:end/;
const blockOf = (source) => {
	const match = BLOCK.exec(source);
	if (!match) throw new Error('hook has no mongo-contract-paths block');
	return match[1];
};

const triggers = (block, file) => spawnSync('bash', ['-c', `${block}\ntouches_mongo_contract "$1"`, 'bash', file]).status === 0;

describe('the Mongo contract trigger in the git hooks', () => {
	const preCommit = read('pre-commit');
	const prePush = read('pre-push');

	it('is the same list in pre-commit and pre-push', () => {
		expect(blockOf(preCommit)).toBe(blockOf(prePush));
	});

	it.each([
		'backend/data/index.js',
		'backend/data/postgres/orders.js',
		'backend/data/mongo/orders.js',
		'backend/prisma/schema.prisma',
		'backend/prisma/migrations/20261011000000_init/migration.sql',
		'backend/prisma.config.cjs',
		'backend/lib/prisma.js',
		'backend/services/stock-ledger.js',
		'backend/models/Order.js',
		'backend/utils/public-code.js',
		'backend/constants/settings.js',
		'backend/queues/stock-queue.js',
		'backend/tests/contract/orders.contract.test.js',
		'backend/tests/helpers/db.js',
		'backend/tests/helpers/db-postgres.js',
		'backend/tests/helpers/factories.js',
		'backend/tests/setup.js',
		'backend/vitest.config.mjs',
		'backend/vitest.contract-mongo.config.mjs',
		'backend/package.json',
		'packages/shared/src/ids.js',
		'pnpm-lock.yaml',
	])('runs for %s', (file) => {
		expect(triggers(blockOf(preCommit), file)).toBe(true);
	});

	it.each([
		'backend/routes/orders.js',
		'backend/middleware/validation.js',
		'backend/scripts/audit-combo-pricing.js',
		'backend/tests/pricing/orders-route.test.js',
		'backend/prisma/README.md',
		'backend/init-database.js',
		'frontend/src/App.jsx',
		'docs/deployment.md',
		'.husky/pre-commit',
		'coolify.compose.yml',
	])('does not run for %s', (file) => {
		expect(triggers(blockOf(preCommit), file)).toBe(false);
	});

	const hooks = [['pre-commit', preCommit], ['pre-push', prePush]];

	it.each(hooks)('%s flags every changed file that touches the contract', (name, source) => {
		expect(source).toContain('if touches_mongo_contract "$f"; then mongo_contract=true; fi');
	});

	it('pre-push also flags the contract when the pushed range cannot be read', () => {
		const failClosed = /\tif ! files="\$\(git diff[^\n]*\n(?:(?!\tfi\n)[\s\S])*?\t\tmongo_contract=true\n[\s\S]*?\t\tcontinue\n\tfi\n/;
		expect(prePush).toMatch(failClosed);
	});

	it.each(hooks)('%s runs the suite only when it was flagged', (name, source) => {
		const guarded = /\nif \[\[ "\$mongo_contract" == true \]\]; then\n\techo [^\n]*\n\t\(cd "\$ROOT\/backend" && pnpm --silent test:contract:mongo\)\nfi\n/;
		expect(source).toMatch(guarded);
	});

	it('pre-commit does not exit as a no-op when only the contract was flagged', () => {
		const gate = preCommit.split('\n').find((line) => line.startsWith('if [[ "$backend_full" == false'));
		expect(gate).toContain('"$mongo_contract" == false');
	});

	it.each(hooks)('%s runs it after knip and before the backend suite', (name, source) => {
		const knip = source.indexOf('pnpm --silent knip)');
		const contract = source.indexOf('pnpm --silent test:contract:mongo)');
		const backend = source.indexOf('pnpm --silent test)');
		expect(knip).toBeGreaterThan(-1);
		expect(contract).toBeGreaterThan(knip);
		expect(backend).toBeGreaterThan(contract);
	});

	it('pre-push runs the whole suite on Mongo after the Postgres one, in the same guarded block', () => {
		const block = /\techo "pre-push: full backend suite"\n\t\(cd "\$ROOT\/backend" && pnpm --silent test\)\n\techo [^\n]*\n\t\(cd "\$ROOT\/backend" && pnpm --silent test:mongo\)\nfi\n/;
		expect(prePush).toMatch(block);
		expect(prePush.indexOf('pnpm --silent test:mongo)')).toBeGreaterThan(prePush.indexOf('heavy_lock_hook SAB-Store'));
	});

	it('pre-commit leaves the whole Mongo suite to pre-push', () => {
		expect(preCommit).not.toContain('pnpm --silent test:mongo');
	});
});
