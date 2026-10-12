const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const { makeProduct, makeOrder, makeCombo } = require('../helpers/factories');
const { countRows, listProducts, listCombos, listOrders, movements } = require('../helpers/db');

const run = promisify(execFile);
const BACKEND = path.resolve(__dirname, '../..');

// The command line, not the exported functions: connecting and the exit code are
// what an operator relies on.
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

describe('audit-combo-pricing', () => {
	it('reads the orders that carry a combo and modifies nothing', async () => {
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
