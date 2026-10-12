const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const { makeProduct, makeOrder, makeCombo, makeLegacyProduct } = require('../helpers/factories');
const {
	countRows, findOrder, unsetOrderField, findProduct, listProducts, listCombos, listOrders, movements,
} = require('../helpers/db');
const { POSTGRES } = require('../helpers/backend');

const run = promisify(execFile);
const BACKEND = path.resolve(__dirname, '../..');

// The command line, not the exported functions: connecting, the default mode
// and the exit code are what an operator relies on.
function runScript(name, ...args) {
	return run(process.execPath, [path.join('scripts', name), ...args], { cwd: BACKEND, env: process.env, timeout: 60000 });
}

// Every row of every business table, so "writes nothing" means no field of any
// row changed, not just that one count stayed put.
async function snapshot() {
	return {
		products: await listProducts(),
		combos: await listCombos(),
		orders: await listOrders(),
		movements: await movements(),
		counts: await Promise.all(['product', 'combo', 'order', 'movement'].map((kind) => countRows(kind))),
	};
}

describe('operational scripts default to a dry run', () => {
	it('backfill-stock-opening reports what it would record and records nothing', async () => {
		await makeProduct({ stockQuantity: 4 });
		await makeProduct({ stockQuantity: 0 });
		const before = await snapshot();

		const { stdout } = await runScript('backfill-stock-opening.js');

		expect(stdout).toContain('dry run');
		expect(stdout).toMatch(/without an opening:\s+2/);
		expect(await snapshot()).toEqual(before);
	});

	it('backfill-stock-opening --apply records the openings', async () => {
		await makeProduct({ stockQuantity: 4 });

		await runScript('backfill-stock-opening.js', '--apply');

		expect(await countRows('movement', { type: 'opening', status: 'applied' })).toBe(1);
	});

	// Skipped on Postgres: builds a legacy row without a public code; public_code is NOT NULL on Postgres, so there is nothing to backfill.
	it.skipIf(POSTGRES)('backfill-public-codes reports the rows without a code and writes none', async () => {
		const legacy = await makeLegacyProduct({ name: 'Móc khoá' });
		const before = await snapshot();

		const { stdout } = await runScript('backfill-public-codes.js');

		expect(stdout).toContain('dry run');
		expect(stdout).toMatch(/products: total 1, without a code 1/);
		expect((await findProduct(legacy._id)).publicCode).toBeUndefined();
		expect(await snapshot()).toEqual(before);
	});

	// Skipped on Postgres: unsets a stored field; stock_deducted is NOT NULL on Postgres and the repository's backfill is a constant no-op.
	it.skipIf(POSTGRES)('backfill-stock-deducted counts orders with no flag and sets nothing until --apply', async () => {
		const order = await makeOrder({ isDirectSale: true });
		await unsetOrderField(order._id, 'stockDeducted');
		const before = await snapshot();

		const dry = await runScript('backfill-stock-deducted.js');
		expect(dry.stdout).toMatch(/orders missing stockDeducted:\s+1/);
		expect((await findOrder(order._id)).stockDeducted).toBeUndefined();
		expect(await snapshot()).toEqual(before);

		await runScript('backfill-stock-deducted.js', '--apply');
		expect((await findOrder(order._id)).stockDeducted).toBe(true);
	});

	it('audit-combo-pricing reads the orders that carry a combo and modifies nothing', async () => {
		const combo = await makeCombo();
		const product = await makeProduct();
		await makeOrder({
			items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 1 }],
			totalAmount: product.price,
			comboInfo: { combos: [{ comboId: combo._id, savings: 5000 }], savings: 5000 },
		});
		const before = await snapshot();

		const { stdout } = await runScript('audit-combo-pricing.js');

		expect(stdout).toMatch(/orders with a combo:\s+1/);
		expect(stdout).toMatch(/combo did NOT qualify:\s+1/);
		expect(stdout).toContain('No data was modified.');
		expect(await snapshot()).toEqual(before);
	});
});
