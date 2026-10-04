/**
 * Micro-benchmark of the combo optimizer (pure, no database).
 *
 *   node scripts/bench-pricing.js [runs] [path/to/combo-optimizer.js]
 *
 * Reports median / p95 wall time per solve and the largest heap growth of one solve.
 * Run with `node --expose-gc` for a stable heap figure. The optional second
 * argument benchmarks another copy of the optimizer for a before/after table.
 *
 * Budgets: typical cart <= 1 ms, worst case <= 50 ms, heap delta <= 10 MB. The
 * adversarial carts are what the public pricing endpoint can be fed, so their
 * time includes the rejection when the state budget is exhausted.
 */

const path = require('path');

const combo = (id, price, ...requirements) => ({
	id,
	price,
	requirements: requirements.map(([category, quantity]) => ({ category, quantity })),
});

const repeat = (price, count) => Array(count).fill(price);

const PRODUCTION_COMBOS = [
	combo('string-tag', 45000, ['string', 1], ['tag', 1]),
	combo('tag-3', 35000, ['tag', 3]),
];

const CARTS = {
	// Three lines, two live combos: what nearly every real order looks like.
	typical: {
		units: { string: [30000, 30000], tag: repeat(20000, 4), badge: [15000] },
		combos: PRODUCTION_COMBOS,
	},
	// 200 units, 4 categories, 5 combos.
	worst: {
		units: {
			a: repeat(30000, 50),
			b: repeat(20000, 50),
			c: repeat(15000, 50),
			d: repeat(10000, 50),
		},
		combos: [
			combo('ab', 45000, ['a', 1], ['b', 1]),
			combo('b3', 55000, ['b', 3]),
			combo('cd', 20000, ['c', 1], ['d', 1]),
			combo('abc', 60000, ['a', 1], ['b', 1], ['c', 1]),
			combo('d2', 15000, ['d', 2]),
		],
	},
	// 200 units over 3 categories with five overlapping combos: the widest state
	// space this shape reaches, so it ends in the budget rejection.
	adversarial: {
		units: { x: repeat(1000, 66), y: repeat(1000, 66), z: repeat(1000, 68) },
		combos: [
			combo('xy', 1500, ['x', 1], ['y', 1]),
			combo('yz', 1500, ['y', 1], ['z', 1]),
			combo('xz', 1500, ['x', 1], ['z', 1]),
			combo('xyz', 2500, ['x', 1], ['y', 1], ['z', 1]),
			combo('x', 900, ['x', 1]),
		],
	},
};

function measure(solve, { units, combos }, runs) {
	const times = [];
	let outcome = 'ok';
	let heapDeltaMb = 0;
	for (let i = 0; i < runs; i++) {
		// Collected before each run so the delta is what one solve allocates.
		if (global.gc) global.gc();
		const heapBefore = process.memoryUsage().heapUsed;
		const start = process.hrtime.bigint();
		try {
			solve(units, combos);
		} catch (error) {
			if (error.name !== 'StateBudgetExceededError') throw error;
			outcome = 'rejected (state budget)';
		}
		times.push(Number(process.hrtime.bigint() - start) / 1e6);
		heapDeltaMb = Math.max(heapDeltaMb, (process.memoryUsage().heapUsed - heapBefore) / 1048576);
	}
	times.sort((a, b) => a - b);
	return {
		median: times[Math.floor(times.length / 2)],
		p95: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))],
		heapDeltaMb,
		outcome,
	};
}

function main() {
	const runs = Number(process.argv[2]) || 200;
	const target = path.resolve(process.argv[3] || path.join(__dirname, '../services/combo-optimizer.js'));
	const { solve } = require(target);

	console.log(`optimizer: ${target}\nruns per cart: ${runs}\n`);
	for (const [name, cart] of Object.entries(CARTS)) {
		// Warm-up so JIT compilation is not billed to the first sample.
		measure(solve, cart, 5);
		const adversarial = name === 'adversarial';
		const result = measure(solve, cart, adversarial ? Math.min(runs, 10) : runs);
		console.log(
			`${name.padEnd(12)} median ${result.median.toFixed(3)} ms  p95 ${result.p95.toFixed(3)} ms  ` +
				`heap ${result.heapDeltaMb.toFixed(2)} MB  ${result.outcome}`
		);
	}
}

if (require.main === module) main();

module.exports = { CARTS };
