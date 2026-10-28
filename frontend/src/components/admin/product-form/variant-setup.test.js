import { describe, it, expect } from 'vitest';
import {
	remapInputs,
	NO_IMAGE,
	applyBulk,
	buildSetup,
	createOption,
	createValue,
	exceedsCombinationLimit,
	gridRows,
	groupIssues,
	inputsFromProduct,
	moveItem,
	optionsFromProduct,
	releaseImage,
	setRowInput,
	validateSetup
} from './variant-setup';

const savedProduct = {
	options: [
		{ name: 'Màu', values: ['Đỏ', 'Xanh'] },
		{ name: 'Size', values: ['M'] }
	],
	variants: [
		{ _id: 'a', optionValues: ['Đỏ', 'M'], price: 120000, sku: 'DO-M', imageUrl: '/uploads/products/a.jpg', isActive: true, stockQuantity: 4 },
		{ _id: 'b', optionValues: ['Xanh', 'M'], isActive: false, stockQuantity: 0 },
		{ _id: 'c', optionValues: ['Vàng', 'M'], isActive: false, archivedAt: '2026-10-01', stockQuantity: 2 }
	]
};

const load = (product = savedProduct) => {
	const options = optionsFromProduct(product);
	return { options, inputs: inputsFromProduct(product, options) };
};

describe('grid rows', () => {
	it('lists every combination in option order', () => {
		const { options, inputs } = load();
		expect(gridRows(options, inputs).map((row) => row.label)).toEqual(['Đỏ / M', 'Xanh / M']);
	});

	it('keeps the inputs of existing rows when a value is added', () => {
		const { options, inputs } = load();
		options[1].values.push(createValue('L'));
		const rows = gridRows(options, inputs);
		expect(rows.map((row) => row.label)).toEqual(['Đỏ / M', 'Đỏ / L', 'Xanh / M', 'Xanh / L']);
		expect(rows[0].input).toMatchObject({ price: '120000', sku: 'DO-M', stockQuantity: 4 });
		expect(rows[1].input.sku).toBe('');
		expect(rows[2].input.isActive).toBe(false);
	});

	it('keeps the inputs when a value is renamed or options are reordered', () => {
		const { options, inputs } = load();
		options[0].values[0].text = 'Đỏ đậm';
		const reordered = moveItem(options, 0, 1);
		const rows = gridRows(reordered, inputs);
		expect(rows[0].label).toBe('M / Đỏ đậm');
		expect(rows[0].input.sku).toBe('DO-M');
	});

	it('gives a product without options the one default row', () => {
		const product = { options: [], variants: [{ optionValues: [], price: 5000, isActive: true, stockQuantity: 3 }] };
		const { options, inputs } = load(product);
		const rows = gridRows(options, inputs);
		expect(rows).toHaveLength(1);
		expect(rows[0].input.price).toBe('5000');
	});

	it('does not turn archived variants into rows', () => {
		const { inputs } = load();
		expect(Object.keys(inputs)).toHaveLength(2);
	});
});

describe('request body', () => {
	it('reports loaded names so a rename keeps the variants', () => {
		const { options, inputs } = load();
		options[0].name = 'Màu sắc';
		options[0].values[1].text = 'Xanh dương';
		options[0].values.push(createValue('Vàng'));
		const { options: sent } = buildSetup({ options, inputs, creating: false });
		expect(sent[0]).toEqual({
			name: 'Màu sắc',
			values: ['Đỏ', 'Xanh dương', 'Vàng'],
			previousName: 'Màu',
			previousValues: ['Đỏ', 'Xanh', null]
		});
	});

	it('sends a new option without previous names', () => {
		const options = [createOption('Màu', null, [createValue('Đỏ')])];
		const { options: sent } = buildSetup({ options, inputs: {}, creating: true });
		expect(sent[0]).toEqual({ name: 'Màu', values: ['Đỏ'] });
	});

	it('maps row inputs to variants and sends opening stock only on create', () => {
		const options = [createOption('Màu', null, [createValue('Đỏ'), createValue('Xanh')])];
		let inputs = {};
		const [red] = gridRows(options, inputs);
		inputs = setRowInput(inputs, red.key, { price: '90000', sku: ' R1 ', openingStock: '7' });
		const created = buildSetup({ options, inputs, creating: true }).variants;
		expect(created[0]).toEqual({ optionValues: ['Đỏ'], price: 90000, sku: 'R1', imageUrl: null, isActive: true, openingStock: 7 });
		expect(created[1]).toEqual({ optionValues: ['Xanh'], price: null, sku: null, imageUrl: null, isActive: true });
		expect(buildSetup({ options, inputs, creating: false }).variants[0]).not.toHaveProperty('openingStock');
	});

	it('builds the default variant when every option was removed', () => {
		const { variants } = buildSetup({ options: [], inputs: {}, creating: false });
		expect(variants).toEqual([{ optionValues: [], price: null, sku: null, imageUrl: null, isActive: true }]);
	});
});

describe('limits and validation', () => {
	it('blocks the 101st combination with the shared message and builds no rows', () => {
		const values = (n) => Array.from({ length: n }, (_, i) => createValue(`v${i}`));
		const options = [createOption('A', null, values(10)), createOption('B', null, values(11))];
		expect(exceedsCombinationLimit(options)).toBe(true);
		const setup = buildSetup({ options, inputs: {}, creating: true });
		expect(setup.variants).toEqual([]);
		const { parts } = groupIssues(validateSetup(setup));
		expect(parts.options).toBe('Tối đa 100 tổ hợp (hiện có 110)');
	});

	it('maps row issues to the row index', () => {
		const options = [createOption('Màu', null, [createValue('Đỏ'), createValue('Xanh')])];
		const rows = gridRows(options, {});
		const inputs = setRowInput({}, rows[1].key, { price: '-5' });
		const { rows: byRow } = groupIssues(validateSetup(buildSetup({ options, inputs, creating: true })));
		expect(Object.keys(byRow)).toEqual(['1']);
	});

	it('accepts a valid setup', () => {
		const { options, inputs } = load();
		inputs[gridRows(options, inputs)[1].key].isActive = true;
		const setup = { images: ['/uploads/products/a.jpg'], ...buildSetup({ options, inputs, creating: false }) };
		expect(validateSetup(setup)).toEqual([]);
	});
});

describe('image helpers', () => {
	it('resets the variants that used a removed image', () => {
		const { inputs } = load();
		const { inputs: next, released } = releaseImage(inputs, '/uploads/products/a.jpg');
		expect(released).toBe(1);
		expect(Object.values(next).every((input) => input.imageUrl === '')).toBe(true);
	});

	it('applies price and image to the rows sharing a value, or to all', () => {
		const options = [createOption('Màu', null, [createValue('Đỏ'), createValue('Xanh')]), createOption('Size', null, [createValue('M'), createValue('L')])];
		const rows = gridRows(options, {});
		const red = options[0].values[0].id;
		const forRed = applyBulk({}, rows, { valueId: red, price: '50000', imageUrl: '/uploads/products/r.jpg' });
		const priced = gridRows(options, forRed).map((row) => row.input.price);
		expect(priced).toEqual(['50000', '50000', '', '']);
		const all = applyBulk(forRed, rows, { price: '1000', imageUrl: NO_IMAGE });
		expect(gridRows(options, all).every((row) => row.input.price === '1000' && row.input.imageUrl === '')).toBe(true);
		expect(applyBulk(all, rows, {})).toBe(all);
	});

	it('moves items within bounds only', () => {
		expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
		const list = ['a', 'b'];
		expect(moveItem(list, 0, -1)).toBe(list);
	});
});

describe('remapInputs', () => {
	const option = (id, name, values) => ({ id, name, previousName: name, values: values.map(([valueId, text]) => ({ id: valueId, text, previous: text })) });
	const color = option('o1', 'Màu', [['r', 'Đỏ'], ['b', 'Xanh']]);
	const size = option('o2', 'Size', [['s', 'S'], ['m', 'M']]);
	const priced = (price) => ({ price, sku: '', imageUrl: '', isActive: true, openingStock: '', stockQuantity: 2 });

	it('gives existing rows the first value of an added option, as the server does', () => {
		const inputs = { r: priced('1'), b: priced('2') };

		const next = remapInputs([color], [color, size], inputs);

		expect(next).toEqual({ 'r|s': priced('1'), 'b|s': priced('2') });
	});

	it('keeps a product without options as the first combination of its first option', () => {
		expect(remapInputs([], [size], { '': priced('5') })).toEqual({ s: priced('5') });
	});

	it('folds rows onto the remaining option when one is removed, the first row winning', () => {
		const inputs = { 'r|s': priced('1'), 'b|s': priced('2'), 'm|r': priced('3') };

		expect(remapInputs([color, size], [size], inputs)).toEqual({ s: priced('1'), m: priced('3') });
	});

	it('drops the rows of a value deleted from an option that stays', () => {
		const smaller = { ...size, values: [size.values[0]] };

		expect(remapInputs([color, size], [color, smaller], { 'r|s': priced('1'), 'm|r': priced('3') })).toEqual({ 'r|s': priced('1') });
	});
});
