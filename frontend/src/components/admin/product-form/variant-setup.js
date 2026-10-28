/*
 * Pure state helpers for the product form's options and variant grid.
 *
 * Every option value carries a stable id. A grid row is keyed by the ids of its values, not by
 * their text, so renaming a value or reordering options keeps what the admin typed in the row.
 */
import { optionCombinations, combinationCount, productVariantSetup, MAX_VARIANT_COMBINATIONS } from '@sab/shared';

// Sentinel of the bulk image select: clear the image instead of keeping each row's own.
export const NO_IMAGE = '__none';

let idSeq = 0;
const nextId = () => `id${++idSeq}`;

export const createValue = (text = '', previous = null) => ({ id: nextId(), text, previous });

export const createOption = (name = '', previousName = null, values = []) => ({
	id: nextId(),
	name,
	previousName,
	values
});

const emptyInput = () => ({
	price: '',
	sku: '',
	imageUrl: '',
	isActive: true,
	openingStock: '',
	stockQuantity: null
});

// Order-independent: moving an option must not turn every row into a "new" one.
const rowKey = (valueIds) => [...valueIds].sort().join('|');

export const moveItem = (list, index, delta) => {
	const target = index + delta;
	if (target < 0 || target >= list.length) return list;
	const next = [...list];
	[next[index], next[target]] = [next[target], next[index]];
	return next;
};

export const exceedsCombinationLimit = (options) => combinationCount(options) > MAX_VARIANT_COMBINATIONS;

export const optionsFromProduct = (product) =>
	(product?.options || []).map((option) =>
		createOption(option.name, option.name, option.values.map((value) => createValue(value, value)))
	);

// Archived variants are not editable rows: the server restores them when their combination returns.
export const inputsFromProduct = (product, options) => {
	const inputs = {};
	(product?.variants || [])
		.filter((variant) => !variant.archivedAt)
		.forEach((variant) => {
			const ids = variant.optionValues.map((text, index) => options[index]?.values.find((value) => value.text === text)?.id);
			if (ids.some((id) => id === undefined)) return;
			inputs[rowKey(ids)] = {
				price: variant.price === null || variant.price === undefined ? '' : String(variant.price),
				sku: variant.sku || '',
				imageUrl: variant.imageUrl || '',
				isActive: variant.isActive !== false,
				openingStock: '',
				stockQuantity: variant.stockQuantity ?? null
			};
		});
	return inputs;
};

export const archivedVariantsOf = (product) => (product?.variants || []).filter((variant) => variant.archivedAt);

export const gridRows = (options, inputs) =>
	optionCombinations(options).map((combination) => {
		const valueIds = combination.map((value) => value.id);
		const optionValues = combination.map((value) => value.text.trim());
		const key = rowKey(valueIds);
		return { key, valueIds, optionValues, label: optionValues.join(' / '), input: inputs[key] || emptyInput() };
	});

/**
 * Carries the row inputs over an options change the way the server carries the
 * variants: a row keeps its inputs while all its values survive; an added option
 * gives every existing row that option's first value; a removed option folds rows
 * that become equal into the first of them. A row whose value was removed is gone.
 */
export const remapInputs = (previousOptions, nextOptions, inputs) => {
	const optionOfValue = new Map();
	nextOptions.forEach((option) => option.values.forEach((value) => optionOfValue.set(value.id, option.id)));
	const previousOptionOfValue = new Map();
	previousOptions.forEach((option) => option.values.forEach((value) => previousOptionOfValue.set(value.id, option.id)));
	const nextOptionIds = new Set(nextOptions.map((option) => option.id));
	const next = {};
	Object.entries(inputs).forEach(([key, input]) => {
		const surviving = [];
		for (const id of key === '' ? [] : key.split('|')) {
			if (optionOfValue.has(id)) surviving.push(id);
			// The value was deleted from an option that is still there: its row is gone.
			else if (nextOptionIds.has(previousOptionOfValue.get(id))) return;
			// Otherwise its whole option was deleted: the row just loses that value.
		}
		const covered = new Set(surviving.map((id) => optionOfValue.get(id)));
		nextOptions.forEach((option) => {
			if (!covered.has(option.id) && option.values.length > 0) surviving.push(option.values[0].id);
		});
		const nextKey = rowKey(surviving);
		if (!(nextKey in next)) next[nextKey] = input;
	});
	return next;
};

export const setRowInput = (inputs, key, patch) => ({
	...inputs,
	[key]: { ...(inputs[key] || emptyInput()), ...patch }
});

/** Writes `price` and/or `imageUrl` into every row, or only the rows holding `valueId`. */
export const applyBulk = (inputs, rows, { valueId = '', price = '', imageUrl = '' }) => {
	const patch = {};
	if (price.trim() !== '') patch.price = price.trim();
	if (imageUrl !== '') patch.imageUrl = imageUrl === NO_IMAGE ? '' : imageUrl;
	if (Object.keys(patch).length === 0) return inputs;
	return rows
		.filter((row) => !valueId || row.valueIds.includes(valueId))
		.reduce((next, row) => setRowInput(next, row.key, patch), inputs);
};

/** Clears `url` from every row that uses it; `released` counts the rows that changed. */
export const releaseImage = (inputs, url) => {
	let released = 0;
	const next = {};
	Object.entries(inputs).forEach(([key, input]) => {
		if (input.imageUrl === url) {
			released += 1;
			next[key] = { ...input, imageUrl: '' };
		} else {
			next[key] = input;
		}
	});
	return { inputs: next, released };
};

// An option that came from the server reports its loaded names so the server keeps the variants of a rename.
const toSetupOptions = (options) =>
	options.map((option) => ({
		name: option.name.trim(),
		values: option.values.map((value) => value.text.trim()),
		...(option.previousName !== null && {
			previousName: option.previousName,
			previousValues: option.values.map((value) => value.previous)
		})
	}));

const toVariantBody = (row, creating) => {
	const { input } = row;
	const price = input.price.trim();
	const sku = input.sku.trim();
	const openingStock = input.openingStock.trim();
	return {
		optionValues: row.optionValues,
		price: price === '' ? null : Number(price),
		sku: sku === '' ? null : sku,
		imageUrl: input.imageUrl || null,
		isActive: input.isActive,
		...(creating && openingStock !== '' && { openingStock: Number(openingStock) })
	};
};

/** The `options` and `variants` request fields for the current form state. */
export const buildSetup = ({ options, inputs, creating }) => ({
	options: toSetupOptions(options),
	// Over the limit the grid is not built (50^n rows); the schema reports the count instead.
	variants: exceedsCombinationLimit(options) ? [] : gridRows(options, inputs).map((row) => toVariantBody(row, creating))
});

export const validateSetup = (setup) => {
	const result = productVariantSetup.safeParse(setup);
	return result.success ? [] : result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
};

/** Groups issues for display: one message per part, one per variant row (index in `variants`). */
export const groupIssues = (issues) => {
	const parts = {};
	const rows = {};
	issues.forEach(({ path, message }) => {
		const [head, index] = path;
		if (head === 'variants' && typeof index === 'number') {
			if (rows[index] === undefined) rows[index] = message;
		} else if (parts[head] === undefined) {
			parts[head] = message;
		}
	});
	return { parts, rows };
};
