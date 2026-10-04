/**
 * services/combo-optimizer.js is a pure function: checked against hand-computed
 * optima, including the cases a greedy pass gets wrong.
 */
const { solve, StateBudgetExceededError } = require('../../services/combo-optimizer');

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('solve', () => {
	it('prefers two applications of B over the combo a greedy pass would start with', () => {
		// X: 4 units of 100, Y: 2 units of 100.
		// A = 1X+1Y for 150 (saves 50 each, up to 2 -> 100). B = 2X for 120 (saves 80 each, up to 2 -> 160).
		// Greedy takes B twice (160) and strands Y; the optimum is 2A + 1B = 180.
		const result = solve(
			{ x: [100, 100, 100, 100], y: [100, 100] },
			[
				{ id: 'A', price: 150, requirements: [{ category: 'x', quantity: 1 }, { category: 'y', quantity: 1 }] },
				{ id: 'B', price: 120, requirements: [{ category: 'x', quantity: 2 }] },
			]
		);

		expect(result.savings).toBe(180);
		expect(result.applications).toEqual(expect.arrayContaining([{ id: 'A', count: 2 }, { id: 'B', count: 1 }]));
	});

	it('does not apply a combo priced at or above its dearest units', () => {
		const result = solve({ x: [100, 80] }, [
			{ id: 'A', price: 180, requirements: [{ category: 'x', quantity: 2 }] },
			{ id: 'B', price: 200, requirements: [{ category: 'x', quantity: 2 }] },
		]);

		expect(result).toEqual({ savings: 0, applications: [] });
	});

	// Shapes of the two live combos; unit prices are illustrative.
	describe('live combo shapes (string 30000, tag 20000)', () => {
		const combos = [
			{ id: 'string-tag', price: 45000, requirements: [{ category: 'string', quantity: 1 }, { category: 'tag', quantity: 1 }] },
			{ id: 'tag-3', price: 35000, requirements: [{ category: 'tag', quantity: 3 }] },
		];
		const cart = (strings, tags) => ({
			string: Array(strings).fill(30000),
			tag: Array(tags).fill(20000),
		});

		it.each([
			['1 string + 1 tag', 1, 1, 5000, [{ id: 'string-tag', count: 1 }]],
			['1 string + 3 tags -> tag-3 beats string-tag', 1, 3, 25000, [{ id: 'tag-3', count: 1 }]],
			['2 strings + 4 tags -> one of each', 2, 4, 30000, [{ id: 'string-tag', count: 1 }, { id: 'tag-3', count: 1 }]],
			['4 tags alone', 0, 4, 25000, [{ id: 'tag-3', count: 1 }]],
			['2 tags: nothing applies', 0, 2, 0, []],
		])('%s', (_label, strings, tags, savings, applications) => {
			const result = solve(cart(strings, tags), combos);
			expect(result.savings).toBe(savings);
			expect(result.applications).toEqual(expect.arrayContaining(applications));
			expect(result.applications).toHaveLength(applications.length);
		});
	});

	it('returns the same result for every ordering of units and combos', () => {
		const combos = [
			{ id: 'p', price: 10, priority: 1, requirements: [{ category: 'a', quantity: 1 }] },
			{ id: 'q', price: 10, priority: 1, requirements: [{ category: 'a', quantity: 1 }] },
			{ id: 'r', price: 10, priority: 2, requirements: [{ category: 'a', quantity: 1 }] },
		];
		const reference = solve({ a: [30, 30, 20] }, combos);

		const random = mulberry32(7);
		for (let i = 0; i < 100; i++) {
			const shuffle = (list) => [...list].sort(() => random() - 0.5);
			expect(solve({ a: shuffle([30, 30, 20]) }, shuffle(combos))).toEqual(reference);
		}
	});

	it('breaks equal-saving ties toward fewer applications, then higher priority', () => {
		// Two 1-unit combos at the same price: the higher-priority one is chosen.
		const sameSaving = solve({ a: [50] }, [
			{ id: 'low', price: 30, priority: 0, requirements: [{ category: 'a', quantity: 1 }] },
			{ id: 'high', price: 30, priority: 5, requirements: [{ category: 'a', quantity: 1 }] },
		]);
		expect(sameSaving.applications).toEqual([{ id: 'high', count: 1 }]);

		// 2 units, same saving (20) either as 1 pair-combo or as 2 single combos: fewer applications wins.
		const fewer = solve({ a: [50, 50] }, [
			{ id: 'single', price: 40, requirements: [{ category: 'a', quantity: 1 }] },
			{ id: 'pair', price: 80, requirements: [{ category: 'a', quantity: 2 }] },
		]);
		expect(fewer.savings).toBe(20);
		expect(fewer.applications).toEqual([{ id: 'pair', count: 1 }]);
	});

	it('sums requirements that repeat a category instead of double-counting availability', () => {
		// 1x hat + 1x hat is 2 hats per application; 3 hats allow 1 application, not 3.
		const result = solve({ hat: [10, 10, 10] }, [
			{ id: 'dup', price: 5, requirements: [{ category: 'hat', quantity: 1 }, { category: 'hat', quantity: 1 }] },
		]);

		expect(result).toEqual({ savings: 15, applications: [{ id: 'dup', count: 1 }] });
	});

	it('ignores a combo that needs a category the cart does not have', () => {
		const result = solve({ a: [10, 10] }, [
			{ id: 'x', price: 1, requirements: [{ category: 'a', quantity: 1 }, { category: 'missing', quantity: 1 }] },
		]);

		expect(result).toEqual({ savings: 0, applications: [] });
	});

	it('throws instead of returning a non-optimal answer when the state budget is exceeded', () => {
		const prices = Array(60).fill(10);
		const combos = [
			{ id: 'a', price: 5, requirements: [{ category: 'x', quantity: 1 }, { category: 'y', quantity: 1 }] },
			{ id: 'b', price: 7, requirements: [{ category: 'x', quantity: 1 }, { category: 'y', quantity: 2 }] },
			{ id: 'c', price: 9, requirements: [{ category: 'x', quantity: 2 }, { category: 'y', quantity: 1 }] },
		];

		expect(() => solve({ x: prices, y: prices }, combos, { stateBudget: 50 })).toThrow(StateBudgetExceededError);
	});

	it('solves the live-sized worst case (200 units, 2 categories, 2 combos) well inside the default budget', () => {
		const combos = [
			{ id: 'string-tag', price: 45000, requirements: [{ category: 'string', quantity: 1 }, { category: 'tag', quantity: 1 }] },
			{ id: 'tag-3', price: 35000, requirements: [{ category: 'tag', quantity: 3 }] },
		];

		const result = solve({ string: Array(80).fill(30000), tag: Array(120).fill(20000) }, combos);

		expect(result.savings).toBeGreaterThan(0);
	});

	it('solves a cart whose full state space is far above the budget but whose reachable part is small', () => {
		const fifty = Array(50).fill(100);

		const result = solve({ a: fifty, b: fifty, c: fifty, d: fifty }, [
			{ id: 'ab', price: 150, requirements: [{ category: 'a', quantity: 1 }, { category: 'b', quantity: 1 }] },
		]);

		expect(result).toEqual({ savings: 2500, applications: [{ id: 'ab', count: 50 }] });
	});
});
