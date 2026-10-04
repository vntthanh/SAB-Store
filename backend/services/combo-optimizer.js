/**
 * Pure combo optimizer: given the unit prices in a cart and the combos on
 * offer, find how many times to apply each combo so the customer pays least.
 *
 * Exchange argument: once the number of applications n_j of every combo is
 * fixed, category c needs need_c = sum_j n_j * q_jc units, and any unit of c
 * satisfies a slot of c. Swapping a cheaper unit in the combo for a dearer one
 * left at retail never lowers the saving, so the optimum puts the need_c
 * DEAREST units of c into combos. Hence
 *
 *   saving(n) = sum_c top_c(need_c) - sum_j n_j * price_j
 *
 * with top_c(k) the sum of the k highest unit prices of c, subject to
 * need_c <= count_c. n = 0 is always feasible, so the result is never worse
 * than retail. The search runs combo by combo over the need vector, memoised.
 *
 * It never degrades to a greedy fallback: a greedy answer is not optimal and
 * would charge a different amount than the preview promises. A cart whose state
 * space exceeds the budget is rejected instead.
 */

// Sized so a rejected cart still returns within ~50 ms: the endpoint is public
// and the search blocks the event loop (measured by scripts/bench-pricing.js).
const DEFAULT_STATE_BUDGET = 60000;

class StateBudgetExceededError extends Error {
	constructor(budget) {
		super(`combo optimizer exceeded ${budget} states`);
		this.name = 'StateBudgetExceededError';
		this.budget = budget;
	}
}

/** Sum the quantities of requirements that share a category. Map<category, quantity>. */
function mergeRequirements(requirements) {
	const merged = new Map();
	for (const requirement of requirements) {
		merged.set(requirement.category, (merged.get(requirement.category) || 0) + requirement.quantity);
	}
	return merged;
}

/**
 * Tie-break order, shared with the caller that assigns concrete units: higher
 * priority first, then smaller id. Deterministic regardless of input order.
 */
function compareCombos(a, b) {
	const byPriority = (b.priority || 0) - (a.priority || 0);
	if (byPriority !== 0) return byPriority;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** top_c(k) for k = 0..n: prefix sums of the unit prices, dearest first. */
function prefixSums(prices) {
	const ascending = Float64Array.from(prices).sort();
	const sums = new Float64Array(ascending.length + 1);
	for (let i = 0; i < ascending.length; i++) sums[i + 1] = sums[i] + ascending[ascending.length - 1 - i];
	return sums;
}

/**
 * Keep the combos that can ever be part of the optimum, as {id, price, cats, qty}
 * over the categories (by index) the cart has.
 *
 * A combo is dropped when it needs a category the cart lacks or more units than
 * it has, and when even its dearest possible units do not beat its price: k
 * applications consume at most k times the dearest single application's value,
 * so removing such a combo from any plan never lowers the saving and lowers the
 * application count, which the tie-break prefers.
 */
function usableCombos(sortedCombos, categoryIndex, available, prefix) {
	const usable = [];
	for (const combo of sortedCombos) {
		const merged = mergeRequirements(combo.requirements);
		const cats = [];
		const qty = [];
		let dearest = 0;
		let feasible = merged.size > 0;
		for (const [category, quantity] of merged) {
			const index = categoryIndex.get(category);
			if (index === undefined || quantity > available[index]) {
				feasible = false;
				break;
			}
			cats.push(index);
			qty.push(quantity);
			dearest += prefix[index][quantity];
		}
		if (feasible && dearest > combo.price) usable.push({ id: combo.id, price: combo.price, cats, qty });
	}
	return usable;
}

/**
 * @param {Object<string, number[]>} unitPricesByCategory unit prices per category, any order
 * @param {Array<{id: string, price: number, priority?: number,
 *                requirements: Array<{category: string, quantity: number}>}>} combos
 * @param {{stateBudget?: number}} [options]
 * @returns {{savings: number, applications: Array<{id: string, count: number}>}}
 *          `applications` lists only combos applied, in `compareCombos` order.
 * @throws {StateBudgetExceededError}
 */
function solve(unitPricesByCategory, combos, { stateBudget = DEFAULT_STATE_BUDGET } = {}) {
	const categories = Object.keys(unitPricesByCategory);
	const categoryIndex = new Map(categories.map((category, index) => [category, index]));
	const available = categories.map((category) => unitPricesByCategory[category].length);
	const prefix = categories.map((category) => prefixSums(unitPricesByCategory[category]));

	const usable = usableCombos([...combos].sort(compareCombos), categoryIndex, available, prefix);
	// Most carts earn no combo: answer without allocating a search.
	if (usable.length === 0) return { savings: 0, applications: [] };

	const levels = usable.length;
	// Mixed-radix key of the units consumed per category: digit c has radix
	// available[c] + 1. A combo application adds a constant `delta` to the key.
	const stride = new Array(categories.length);
	let keySpace = 1;
	for (let c = 0; c < categories.length; c++) {
		stride[c] = keySpace;
		keySpace *= available[c] + 1;
	}
	for (const combo of usable) combo.delta = combo.cats.reduce((sum, c, i) => sum + combo.qty[i] * stride[c], 0);

	// The memo key combines the level and the digits; a space too large for an
	// exact double cannot be keyed, and could not fit the budget anyway.
	if (levels * keySpace > Number.MAX_SAFE_INTEGER) throw new StateBudgetExceededError(stateBudget);

	// Dense: every state has a slot, no hashing. Sparse: a huge space of which a
	// search only reaches a few states, slotted on first visit.
	const dense = levels * keySpace <= stateBudget;
	const slotOf = dense ? null : new Map();
	let capacity = dense ? levels * keySpace : Math.min(stateBudget, 1024);
	let values = new Float64Array(capacity).fill(NaN);
	let apps = new Int32Array(capacity);
	let choice = new Int32Array(capacity);

	function grow() {
		capacity *= 2;
		const nextValues = new Float64Array(capacity).fill(NaN);
		nextValues.set(values);
		const nextApps = new Int32Array(capacity);
		nextApps.set(apps);
		const nextChoice = new Int32Array(capacity);
		nextChoice.set(choice);
		values = nextValues;
		apps = nextApps;
		choice = nextChoice;
	}

	const used = new Int32Array(categories.length);
	let returnedApps = 0;

	// Returns the best saving from `level` onward and leaves its application
	// count in returnedApps. Equal savings prefer fewer applications, then the
	// larger count of this level's combo (the lexicographically larger vector).
	function visit(level, key) {
		if (level === levels) {
			let top = 0;
			for (let c = 0; c < used.length; c++) top += prefix[c][used[c]];
			returnedApps = 0;
			return top;
		}

		const memoKey = level * keySpace + key;
		let slot = dense ? memoKey : slotOf.get(memoKey);
		if (slot !== undefined && !Number.isNaN(values[slot])) {
			returnedApps = apps[slot];
			return values[slot];
		}
		if (!dense && slotOf.size >= stateBudget) throw new StateBudgetExceededError(stateBudget);

		const combo = usable[level];
		const { cats, qty } = combo;
		let maxCount = Infinity;
		for (let i = 0; i < cats.length; i++) {
			const room = Math.floor((available[cats[i]] - used[cats[i]]) / qty[i]);
			if (room < maxCount) maxCount = room;
		}

		let bestValue = -Infinity;
		let bestApps = 0;
		let bestCount = 0;
		for (let count = 0; count <= maxCount; count++) {
			if (count > 0) for (let i = 0; i < cats.length; i++) used[cats[i]] += qty[i];
			const value = visit(level + 1, key + count * combo.delta) - count * combo.price;
			const total = returnedApps + count;
			if (value > bestValue || (value === bestValue && total <= bestApps)) {
				bestValue = value;
				bestApps = total;
				bestCount = count;
			}
		}
		for (let i = 0; i < cats.length; i++) used[cats[i]] -= maxCount * qty[i];

		// Slotted only now: the recursion above adds the descendants' slots first.
		if (!dense) {
			slot = slotOf.size;
			slotOf.set(memoKey, slot);
			if (slot >= capacity) grow();
		}
		values[slot] = bestValue;
		apps[slot] = bestApps;
		choice[slot] = bestCount;
		returnedApps = bestApps;
		return bestValue;
	}

	const savings = visit(0, 0);

	const applications = [];
	let key = 0;
	for (let level = 0; level < levels; level++) {
		const memoKey = level * keySpace + key;
		const count = choice[dense ? memoKey : slotOf.get(memoKey)];
		if (count > 0) applications.push({ id: usable[level].id, count });
		key += count * usable[level].delta;
	}
	return { savings, applications };
}

module.exports = {
	solve,
	mergeRequirements,
	StateBudgetExceededError,
};
