/**
 * Fold products that stand in for the values of one option (one product per
 * size) into one product with that option. Dry run by default: everything runs
 * in one transaction that is rolled back, and the report says what would change.
 * `--apply` commits, then hands the stock movements to the queue.
 *
 *   node scripts/merge-products-into-variants.js \
 *     --target <product id> --name "Áo SAB" --option Size --channel online \
 *     --values XS,S,M,L,XL,2XL,3XL,4XL,5XL,6XL \
 *     --source <id>=XS --source <id>=S ... [--apply]
 *
 * The target is one of the sources and its value comes first in --values; values
 * without a source become variants with no stock. Order codes, totals and
 * statuses are never changed: only the order lines are pointed at the new
 * variants. The report prints product codes and order line counts, never customer
 * data. Take an admin export before `--apply`.
 */
require('dotenv').config({ quiet: true });
const { connectDB, closeDB } = require('../lib/database');
const { withTransaction } = require('../data');
const { mergeIntoVariants } = require('../data/postgres/product-merge');
const { recordMovement, enqueueMovements } = require('../services/stock-ledger');

class DryRun extends Error {
	constructor(result) {
		super('dry run');
		this.result = result;
	}
}

function parseArgs(argv) {
	const args = { sources: [], apply: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === '--apply') args.apply = true;
		else if (flag === '--source') {
			const [productId, label] = String(value).split('=');
			args.sources.push({ productId, value: label });
			i++;
		} else if (['--target', '--name', '--option', '--channel', '--values'].includes(flag)) {
			args[flag.slice(2)] = value;
			i++;
		} else throw new Error(`Unknown argument: ${flag}`);
	}
	for (const required of ['target', 'name', 'option', 'channel', 'values']) {
		if (!args[required]) throw new Error(`--${required} is required`);
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const merge = {
		targetId: args.target,
		name: args.name,
		optionName: args.option,
		salesChannel: args.channel,
		values: args.values.split(',').map((value) => value.trim()).filter(Boolean),
		sources: args.sources
	};

	await connectDB();
	let result;
	try {
		result = await withTransaction(async (tx) => {
			const merged = await mergeIntoVariants(merge, tx, recordMovement);
			if (!args.apply) throw new DryRun(merged);
			return merged;
		});
	} catch (error) {
		if (!(error instanceof DryRun)) throw error;
		result = error.result;
	}
	if (args.apply) await enqueueMovements(result.movements);

	console.log(args.apply ? '--- merged (committed) ---' : '--- dry run (rolled back) ---');
	console.log(`target ${result.targetId} as "${merge.name}", option ${merge.optionName}, channel ${merge.salesChannel}`);
	for (const variant of result.variants) {
		console.log(`  ${variant.value.padEnd(6)} from ${variant.fromCode ?? '(new)'}  stock moved ${variant.stockMoved}  order lines ${variant.orderLines}`);
	}
	console.log(`retired: ${result.retiredCodes.join(', ') || '(none)'}`);
	console.log(`stock movements: ${result.movements.length}`);
}

main()
	.then(() => closeDB())
	.catch(async (error) => {
		console.error(error.message);
		await closeDB();
		process.exit(1);
	});
