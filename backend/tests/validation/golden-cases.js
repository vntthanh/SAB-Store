/**
 * Inputs for the validation golden fixture.
 *
 * Every case is replayed against the real app; the observed status and error
 * list are what packages/shared/tests/fixtures/validation-golden.json stores.
 * Product ids are well-formed but absent from the database, so a request that
 * clears validation stops in the handler without writing anything.
 */
const OID = '507f1f77bcf86cd799439011';

// Marks "leave this key out of the body" (JSON cannot carry `undefined`).
const MISSING = Symbol('missing');

const ORDER_CREATE = 'POST /api/orders';
const COMBO_PRICING = 'POST /api/combos/pricing';
const PASSWORD_CHANGE = 'POST /api/seller/change-password';
const DIRECT_ORDER = 'POST /api/seller/orders/direct';
const SELLER_STATUS = 'PUT /api/seller/orders/:id/status';
const ADMIN_STATUS = 'PUT /api/admin/orders/:id';
const ITEMS_EDIT = 'PUT /api/admin/orders/:id/items';
const NOTES_EDIT = 'PATCH /api/admin/orders/:id/notes';

const longText = (n, ch = 'a') => ch.repeat(n);

const orderBase = () => ({
	studentId: '24120001',
	fullName: 'Nguyen Van A',
	email: 'a@example.com',
	phoneNumber: '0987654321',
	additionalNote: '',
	items: [{ productId: OID, quantity: 1 }],
	expectedTotal: 0,
});
const directBase = () => ({ items: [{ productId: OID, quantity: 1 }], expectedTotal: 0 });
const comboBase = () => ({ items: [{ productId: OID, quantity: 1 }] });
const statusBase = () => ({ status: 'confirmed' });
const itemsEditBase = () => ({
	items: [{ productId: OID, quantity: 1 }],
	expectedRevision: 0,
	reason: 'doi san pham',
});
const notesBase = () => ({ note: 'ghi chu noi bo' });
const passwordBase = () => ({ currentPassword: 'wrong-current-password', newPassword: 'Abcdefg1' });

// Type confusion every field must survive with a 400 or a clean pass, never a 500.
const WRONG_TYPES = [
	['null', null],
	['empty string', ''],
	['spaces only', '   '],
	['zero', 0],
	['one', 1],
	['true', true],
	['false', false],
	['empty array', []],
	['array of string', ['x']],
	['empty object', {}],
	['operator object', { $ne: null }],
	['operator object gt', { $gt: '' }],
	['plain text', 'abc'],
];

const cases = [];

function add(route, name, body, extra = {}) {
	const entry = { route, name, ...extra };
	if (typeof body === 'string' && extra.raw) entry.rawBody = body;
	else entry.body = body;
	delete entry.raw;
	cases.push(entry);
}

function withField(base, field, value) {
	const copy = base();
	if (value === MISSING) delete copy[field];
	else copy[field] = value;
	return copy;
}

function fieldCases(route, base, field, variants, params) {
	for (const [label, value] of variants) {
		add(route, `${field}: ${label}`, withField(base, field, value), params ? { params } : {});
	}
}

function bodyShapeCases(route, params) {
	const extra = params ? { params } : {};
	add(route, 'body: null', 'null', { raw: true, ...extra });
	add(route, 'body: array', '[]', { raw: true, ...extra });
	add(route, 'body: string', '"text"', { raw: true, ...extra });
	add(route, 'body: number', '5', { raw: true, ...extra });
	add(route, 'body: empty', '', { raw: true, ...extra });
	add(route, 'body: empty object', {}, extra);
}

// An `items` array shared by the three cart routes.
function itemsCases(route, base, { maxQuantity, params, extraQuantities = [] }) {
	const extra = params ? { params } : {};
	const wrongItems = [
		['missing', MISSING],
		['null', null],
		['empty array', []],
		['string', 'x'],
		['number', 5],
		['object', {}],
		['operator object', { $ne: null }],
		['array of null', [null]],
		['array of number', [1]],
		['array of string', ['x']],
		['array of empty object', [{}]],
		['item without quantity', [{ productId: OID }]],
		['item without productId', [{ quantity: 1 }]],
		['nested array item', [[{ productId: OID, quantity: 1 }]]],
	];
	fieldCases(route, base, 'items', wrongItems, params);

	const item = (patch) => ({ ...{ productId: OID, quantity: 1 }, ...patch });
	const put = (name, items) => add(route, name, { ...base(), items }, extra);

	put('items: one valid item', [item({})]);
	put('items: two valid items', [item({}), item({ productId: '507f1f77bcf86cd799439012', quantity: 2 })]);
	put('items: bad quantity at index 0', [item({ quantity: 0 }), item({})]);
	put('items: bad quantity at index 1', [item({}), item({ quantity: 0 })]);
	put('items: bad quantity at index 2', [item({}), item({}), item({ quantity: 0 })]);
	put('items: bad productId at index 1', [item({}), item({ productId: 'nope' })]);
	put('items: both fields bad at index 1', [item({}), item({ productId: 'nope', quantity: 'x' })]);
	put('items: extra key on item', [item({ price: 1, isAdmin: true })]);
	put('items: uppercase hex productId', [item({ productId: OID.toUpperCase() })]);
	put('items: padded productId', [item({ productId: ` ${OID} ` })]);

	const productIds = [
		['23 hex chars', OID.slice(0, 23)],
		['25 hex chars', `${OID}a`],
		['non hex chars', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
		['number', 123456789012],
		['null', null],
		['empty', ''],
		['array', [OID]],
		['operator object', { $ne: null }],
		['missing', undefined],
	];
	for (const [label, productId] of productIds) {
		put(`items[0].productId: ${label}`, [productId === undefined ? { quantity: 1 } : { productId, quantity: 1 }]);
	}

	const quantities = [
		['zero', 0],
		['one', 1],
		['two', 2],
		['negative', -1],
		['fractional', 1.5],
		['integral float', 2.0],
		['numeric string', '2'],
		['zero-padded string', '02'],
		['padded string', ' 2'],
		['signed string', '+2'],
		['negative string', '-2'],
		['float string', '2.0'],
		['exponent string', '1e2'],
		['hex string', '0x10'],
		['word', 'abc'],
		['empty string', ''],
		['null', null],
		['true', true],
		['array of number', [2]],
		['array of string', ['2']],
		['operator object', { $ne: null }],
		['huge number', 1e21],
		['unsafe integer', 9007199254740993],
		['long digit string', '99999999999999999999'],
	];
	if (maxQuantity) {
		quantities.push(['max', maxQuantity], ['max + 1', maxQuantity + 1]);
	}
	for (const q of extraQuantities) quantities.push(q);
	for (const [label, quantity] of quantities) {
		put(`items[0].quantity: ${label}`, [{ productId: OID, quantity }]);
	}
	const manyItems = (n) => Array.from({ length: n }, (_, i) => ({
		productId: OID.slice(0, 20) + String(1000 + i),
		quantity: 1,
	}));
	return { put, manyItems };
}

function unknownKeyCases(route, base, params) {
	add(route, 'unknown keys are tolerated', { ...base(), isAdmin: true, totalAmount: 1, price: 1 }, params ? { params } : {});
}

// ---- POST /api/orders ----------------------------------------------------

add(ORDER_CREATE, 'valid', orderBase());
add(ORDER_CREATE, 'valid without additionalNote', withField(orderBase, 'additionalNote', MISSING));
add(ORDER_CREATE, 'all fields bad', {
	studentId: 'x', fullName: '1', email: 'no', phoneNumber: '1', additionalNote: 'a'.repeat(501),
	items: [], expectedTotal: 'x',
});
add(ORDER_CREATE, 'empty body object reports every required field', {});
unknownKeyCases(ORDER_CREATE, orderBase);
bodyShapeCases(ORDER_CREATE);

fieldCases(ORDER_CREATE, orderBase, 'studentId', [
	['missing', MISSING],
	...WRONG_TYPES,
	['numeric', 24120001],
	['padded', ' 24120001 '],
	['7 digits', '2412000'],
	['9 digits', '241200012'],
	['K15', '15120001'],
	['K16', '16000000'],
	['K26', '26999999'],
	['K27', '27120001'],
	['letters', 'abcdefgh'],
	['inner space', '2412 0001'],
	['newline', '24120001\n'],
]);
fieldCases(ORDER_CREATE, orderBase, 'fullName', [
	['missing', MISSING],
	...WRONG_TYPES,
	['numeric', 12],
	['one char', 'A'],
	['two chars', 'An'],
	['100 chars', longText(100)],
	['101 chars', longText(101)],
	['digits', 'Nguyen 123'],
	['accents', 'Nguyễn Văn Á'],
	['padded', '  Nguyễn Văn A  '],
	['padded two chars', '  A  '],
	['padded 100 chars', ` ${longText(100)} `],
	['symbol', 'Nguyen-Van'],
	['multiplication sign', 'Nguyen × Van'],
	['inner newline', 'Nguyen\nVan'],
	['tab only', '\t\t'],
]);
fieldCases(ORDER_CREATE, orderBase, 'email', [
	['missing', MISSING],
	...WRONG_TYPES,
	['numeric', 5],
	['plain', 'user@example.com'],
	['mixed case', 'User.Name@Example.COM'],
	['padded', ' user@example.com '],
	['plus tag', 'user+tag@example.com'],
	['subdomain', 'user.name@sub.example.com'],
	['no tld', 'user@localhost'],
	['one-letter tld', 'user@example.c'],
	['double at', 'user@@example.com'],
	['leading dot', '.user@example.com'],
	['consecutive dots', 'user..name@example.com'],
	['trailing dot local', 'user.@example.com'],
	['utf8 local', 'üser@example.com'],
	['underscore domain', 'user@exam_ple.com'],
	['leading hyphen domain', 'user@-example.com'],
	['ip domain', 'user@[127.0.0.1]'],
	['display name', 'User <user@example.com>'],
	['quoted local', '"user name"@example.com'],
	['apostrophe', "o'brien@example.com"],
	['no local', '@example.com'],
	['no domain', 'user@'],
	['100 chars', `${longText(55)}@${longText(41, 'b')}.com`],
	['101 chars', `${longText(56)}@${longText(41, 'b')}.com`],
]);
fieldCases(ORDER_CREATE, orderBase, 'phoneNumber', [
	['missing', MISSING],
	...WRONG_TYPES,
	['numeric', 987654321],
	['padded', ' 0987654321 '],
	['9 digits', '098765432'],
	['11 digits', '09876543210'],
	['no leading zero', '1987654321'],
	['letters', '09876abcde'],
	['international', '+84987654321'],
	['inner space', '098 765 432'],
]);
fieldCases(ORDER_CREATE, orderBase, 'additionalNote', [
	['missing', MISSING],
	...WRONG_TYPES,
	['numeric', 12],
	['text', 'giao truoc 9h'],
	['500 chars', longText(500)],
	['501 chars', longText(501)],
	['padded 500 chars', ` ${longText(500)} `],
]);
fieldCases(ORDER_CREATE, orderBase, 'expectedTotal', [
	['missing', MISSING],
	['null', null],
	['empty string', ''],
	['zero', 0],
	['positive', 300000],
	['negative', -1],
	['fractional', 1.5],
	['numeric string', '100'],
	['true', true],
	['empty array', []],
	['array of number', [100]],
	['empty object', {}],
	['operator object', { $ne: null }],
	['huge number', 1e21],
	['unsafe integer', 9007199254740993],
]);
{
	const { put, manyItems } = itemsCases(ORDER_CREATE, orderBase, { maxQuantity: 100 });
	put('items: 100 distinct items', manyItems(100));
	put('items: 101 distinct items', manyItems(101));
}

// ---- POST /api/combos/pricing -------------------------------------------

add(COMBO_PRICING, 'valid', comboBase());
add(COMBO_PRICING, 'valid with channel offline', { ...comboBase(), channel: 'offline' });
add(COMBO_PRICING, 'valid with unknown channel', { ...comboBase(), channel: 'bogus' });
add(COMBO_PRICING, 'valid with operator channel', { ...comboBase(), channel: { $ne: null } });
unknownKeyCases(COMBO_PRICING, comboBase);
bodyShapeCases(COMBO_PRICING);
{
	const { put, manyItems } = itemsCases(COMBO_PRICING, comboBase, { maxQuantity: 200 });
	put('items: 100 distinct items', manyItems(100));
	put('items: 101 distinct items', manyItems(101));
}

// ---- POST /api/seller/change-password -----------------------------------

add(PASSWORD_CHANGE, 'valid', passwordBase());
add(PASSWORD_CHANGE, 'both bad', { currentPassword: '', newPassword: 'abc' });
unknownKeyCases(PASSWORD_CHANGE, passwordBase);
bodyShapeCases(PASSWORD_CHANGE);
fieldCases(PASSWORD_CHANGE, passwordBase, 'currentPassword', [
	['missing', MISSING],
	...WRONG_TYPES,
	['numeric', 12345678],
	['padded', ' wrong-current-password '],
	['one char', 'x'],
	['very long', longText(1000)],
]);
fieldCases(PASSWORD_CHANGE, passwordBase, 'newPassword', [
	['missing', MISSING],
	...WRONG_TYPES,
	['numeric', 12345678],
	['7 chars', 'Abcdef1'],
	['8 chars', 'Abcdefg1'],
	['128 chars', `A${longText(127, 'b')}`],
	['129 chars', `A${longText(128, 'b')}`],
	['no lowercase', 'ABCDEFG1'],
	['no uppercase', 'abcdefg1'],
	['no digit', 'Abcdefgh'],
	['common password', 'Password1'],
	['common password lower', 'password'],
	['common password padded', ' Password1 '],
	['padded valid', ' Abcdefg1 '],
	['spaces only 8', '        '],
	['unicode', 'Mậtkhẩu1A'],
	['all rules broken', 'a'],
]);

// ---- POST /api/seller/orders/direct -------------------------------------

add(DIRECT_ORDER, 'valid', directBase());
add(DIRECT_ORDER, 'valid with allowOverMax true', { ...directBase(), allowOverMax: true });
add(DIRECT_ORDER, 'valid with allowOverMax string', { ...directBase(), allowOverMax: 'true' });
add(DIRECT_ORDER, 'valid with allowOverMax operator', { ...directBase(), allowOverMax: { $ne: null } });
add(DIRECT_ORDER, 'allowOverMax null', { ...directBase(), allowOverMax: null });
unknownKeyCases(DIRECT_ORDER, directBase);
bodyShapeCases(DIRECT_ORDER);
fieldCases(DIRECT_ORDER, directBase, 'expectedTotal', [
	['missing', MISSING],
	['null', null],
	['empty string', ''],
	['zero', 0],
	['positive', 300000],
	['negative', -1],
	['fractional', 1.5],
	['numeric string', '100'],
	['true', true],
	['empty array', []],
	['array of number', [100]],
	['empty object', {}],
	['operator object', { $ne: null }],
	['huge number', 1e21],
	['unsafe integer', 9007199254740993],
]);
itemsCases(DIRECT_ORDER, directBase, { maxQuantity: 200 });

// ---- order status updates (seller + admin) ------------------------------

function statusCases(route) {
	const params = { id: OID };
	add(route, 'valid', statusBase(), { params });
	add(route, 'valid with all optional fields', {
		status: 'paid', transactionCode: 'TX1', cancelReason: 'khong', note: 'ghi chu',
	}, { params });
	add(route, 'all fields bad', { status: 'x', transactionCode: 'x'.repeat(51), cancelReason: 'x'.repeat(501), note: 'x'.repeat(501) }, { params });
	unknownKeyCases(route, statusBase, params);
	bodyShapeCases(route, params);
	for (const [label, id] of [
		['id: not an ObjectId', 'not-an-id'],
		['id: 23 hex chars', OID.slice(0, 23)],
		['id: uppercase hex', OID.toUpperCase()],
		['id: numeric', '12345'],
	]) {
		add(route, label, statusBase(), { params: { id } });
	}
	fieldCases(route, statusBase, 'status', [
		['missing', MISSING],
		...WRONG_TYPES,
		['confirmed', 'confirmed'],
		['paid', 'paid'],
		['delivered', 'delivered'],
		['cancelled', 'cancelled'],
		['pending', 'pending'],
		['uppercase', 'PAID'],
		['padded', ' paid '],
		['array of valid', ['paid']],
		['array of invalid', ['x']],
	], params);
	for (const [field, max] of [['transactionCode', 50], ['cancelReason', 500], ['note', 500]]) {
		fieldCases(route, statusBase, field, [
			['missing', MISSING],
			...WRONG_TYPES,
			['numeric', 123],
			['text', 'abc'],
			[`${max} chars`, longText(max)],
			[`${max + 1} chars`, longText(max + 1)],
			['padded', '  abc  '],
			[`padded ${max} chars`, ` ${longText(max)} `],
		], params);
	}
}
statusCases(SELLER_STATUS);
statusCases(ADMIN_STATUS);

// ---- PUT /api/admin/orders/:id/items ------------------------------------

{
	const params = { id: OID };
	add(ITEMS_EDIT, 'valid', itemsEditBase(), { params });
	add(ITEMS_EDIT, 'all fields bad', { items: [], expectedRevision: 'x', reason: '' }, { params });
	unknownKeyCases(ITEMS_EDIT, itemsEditBase, params);
	bodyShapeCases(ITEMS_EDIT, params);
	for (const [label, id] of [
		['id: not an ObjectId', 'not-an-id'],
		['id: 23 hex chars', OID.slice(0, 23)],
		['id: uppercase hex', OID.toUpperCase()],
	]) {
		add(ITEMS_EDIT, label, itemsEditBase(), { params: { id } });
	}
	const { put, manyItems } = itemsCases(ITEMS_EDIT, itemsEditBase, { params });
	put('items: 50 distinct items', manyItems(50));
	put('items: 51 distinct items', manyItems(51));
	fieldCases(ITEMS_EDIT, itemsEditBase, 'expectedRevision', [
		['missing', MISSING],
		...WRONG_TYPES,
		['positive', 7],
		['negative', -1],
		['fractional', 1.5],
		['numeric string', '3'],
		['zero-padded string', '03'],
		['padded string', ' 3'],
		['signed string', '+3'],
		['negative string', '-3'],
		['float string', '3.0'],
		['array of number', [3]],
		['array of numeric string', ['3']],
		['huge number', 1e21],
		['unsafe integer', 9007199254740993],
	], params);
	fieldCases(ITEMS_EDIT, itemsEditBase, 'reason', [
		['missing', MISSING],
		...WRONG_TYPES,
		['numeric', 123],
		['text', 'doi hang'],
		['200 chars', longText(200)],
		['201 chars', longText(201)],
		['padded', '  doi hang  '],
		['padded 200 chars', ` ${longText(200)} `],
		['padded 201 chars', ` ${longText(201)} `],
	], params);
}

// ---- PATCH /api/admin/orders/:id/notes ----------------------------------

{
	const params = { id: OID };
	add(NOTES_EDIT, 'valid note only', notesBase(), { params });
	add(NOTES_EDIT, 'valid additionalNote only', { additionalNote: 'ghi chu khach' }, { params });
	add(NOTES_EDIT, 'valid both', { additionalNote: 'khach', note: 'noi bo' }, { params });
	add(NOTES_EDIT, 'neither field', {}, { params });
	add(NOTES_EDIT, 'neither field but unknown key', { other: 'x' }, { params });
	add(NOTES_EDIT, 'both bad', { additionalNote: 'x'.repeat(501), note: '' }, { params });
	bodyShapeCases(NOTES_EDIT, params);
	for (const [label, id] of [
		['id: not an ObjectId', 'not-an-id'],
		['id: 23 hex chars', OID.slice(0, 23)],
		['id: uppercase hex', OID.toUpperCase()],
	]) {
		add(NOTES_EDIT, label, notesBase(), { params: { id } });
	}
	const noteVariants = (max) => [
		...WRONG_TYPES,
		['numeric', 123],
		['text', 'abc'],
		[`${max} chars`, longText(max)],
		[`${max + 1} chars`, longText(max + 1)],
		['padded', '  abc  '],
		[`padded ${max} chars`, ` ${longText(max)} `],
	];
	fieldCases(NOTES_EDIT, notesBase, 'note', noteVariants(500), params);
	fieldCases(NOTES_EDIT, notesBase, 'additionalNote', noteVariants(500), params);
	// additionalNote with a valid note beside it, and with nothing beside it.
	for (const [label, value] of noteVariants(500)) {
		add(NOTES_EDIT, `additionalNote alone: ${label}`, { additionalNote: value }, { params });
	}
	for (const [label, value] of noteVariants(500)) {
		add(NOTES_EDIT, `note alone: ${label}`, { note: value }, { params });
	}
	add(NOTES_EDIT, 'additionalNote empty string clears the note', { additionalNote: '' }, { params });
}

module.exports = { cases, OID, MISSING };
