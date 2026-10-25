/**
 * The rules Mongoose enforced when an order was written (trim, case, required,
 * length, minimum, enum, regex), for the paths that reach the repository without
 * request validation: the merge import, scripts, and any caller that builds an
 * order itself. Messages are those of the schema they replace.
 *
 * Each function returns the cleaned column values and child rows (without
 * `orderId` or `position`, which the repository assigns) and throws one
 * `RecordValidationError` naming every field it refused. The CHECKs of the
 * migration (phone shape, non-negative money, quantity >= 1) stay as the last line.
 */
const { OrderStatus, Prisma } = require('../../generated/prisma/client');
const { Problems, checkText, checkNumber, checkBoolean, checkEnum, checkDate, recordId } = require('./rules');
const { mapJsonIds } = require('./json-ids');

const STATUS_VALUES = Object.values(OrderStatus);
const PHONE = /^0[0-9]{9}$/;
// Same language as the Mongo model's pattern, written so a failing match is linear: with
// `([.-]?\w+)*` a long address that does not match backtracks exponentially, and a private
// storefront's order stores the session's address, which no earlier gate bounds.
const EMAIL = /^\w+(?:[.-]\w+)*@\w+(?:[.-]\w+)*(?:\.\w{2,3})+$/;

const requiredMessage = (name) => `Path \`${name}\` is required.`;
const tooLong = (name, max) => `Path \`${name}\` is longer than the maximum allowed length (${max}).`;
const invalid = (name) => `Giá trị của "${name}" không hợp lệ`;

/** A required value that was left out counts as null, which `checkText` and `checkNumber` refuse. */
const given = (value) => (value === undefined ? null : value);

/** Text checks bound to one `Problems`, so a rule reads as one line. */
function checks(problems) {
	return {
		text: (name, value, rules = {}) => checkText(problems, name, value, rules),
		required: (name, value, rules = {}) => checkText(problems, name, given(value), { required: true, requiredMessage: requiredMessage(name), ...rules }),
		number: (name, value, rules = {}) => checkNumber(problems, name, value, rules),
		id(name, value, { required = false } = {}) {
			if (value === undefined || value === null) {
				if (required) problems.add(name, requiredMessage(name));
				return null;
			}
			try {
				return recordId(value, name);
			} catch {
				problems.add(name, invalid(name));
				return undefined;
			}
		}
	};
}

const noteRules = { max: 500, maxMessage: 'Ghi chú không được vượt quá 500 ký tự' };
const cancelReasonRules = { max: 500, maxMessage: 'Lý do hủy không được vượt quá 500 ký tự' };
const transactionCodeRules = { max: 50, maxMessage: 'Mã giao dịch không được vượt quá 50 ký tự' };

/** Columns shared by the order write and a status change. */
function statusColumns(problems, fields) {
	const { text } = checks(problems);
	return {
		status: checkEnum(problems, 'status', fields.status, STATUS_VALUES),
		statusUpdatedAt: checkDate(problems, 'statusUpdatedAt', fields.statusUpdatedAt),
		lastUpdatedBy: text('lastUpdatedBy', fields.lastUpdatedBy ?? undefined, { trim: false }),
		transactionCode: text('transactionCode', fields.transactionCode, transactionCodeRules),
		cancelReason: text('cancelReason', fields.cancelReason, cancelReasonRules)
	};
}

const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

/** JSON column value: `null` is a SQL NULL, not a JSON null. */
const jsonOrNull = (value) => (value === null || value === undefined ? Prisma.DbNull : mapJsonIds(value));

const STATUS_CHANGE_FIELDS = ['status', 'statusUpdatedAt', 'lastUpdatedBy', 'transactionCode', 'cancelReason', 'stockDeducted'];

/**
 * Column values of a status change. Only the fields a transition sets are taken;
 * anything else is a programming error, not data, and is refused loudly.
 *
 * @throws {TypeError} a field that no transition sets
 * @throws {RecordValidationError}
 */
function statusChangeColumns(fields) {
	const unknown = Object.keys(fields).find((key) => !STATUS_CHANGE_FIELDS.includes(key));
	if (unknown !== undefined) throw new TypeError(`Cannot set order field in a status change: ${unknown}`);
	const problems = new Problems();
	const columns = { ...statusColumns(problems, fields), stockDeducted: checkBoolean(problems, 'stockDeducted', fields.stockDeducted) };
	problems.throwIfAny();
	return defined(columns);
}

function historyData(problems, entry, at = 'statusHistory') {
	const { text, required } = checks(problems);
	return defined({
		status: checkEnum(problems, `${at}.status`, given(entry.status), STATUS_VALUES),
		updatedBy: required(`${at}.updatedBy`, entry.updatedBy, { trim: false }),
		updatedAt: checkDate(problems, `${at}.updatedAt`, entry.updatedAt),
		transactionCode: text(`${at}.transactionCode`, entry.transactionCode, transactionCodeRules),
		cancelReason: text(`${at}.cancelReason`, entry.cancelReason, cancelReasonRules),
		note: text(`${at}.note`, entry.note, noteRules)
	});
}

function noteData(problems, entry, at = 'internalNotes') {
	const { required } = checks(problems);
	return defined({
		note: required(`${at}.note`, entry.note, noteRules),
		by: required(`${at}.by`, entry.by, { trim: false }),
		at: checkDate(problems, `${at}.at`, entry.at)
	});
}

function editData(problems, entry, at = 'itemsHistory') {
	const { required } = checks(problems);
	if (entry.previousItems !== undefined && !Array.isArray(entry.previousItems)) problems.add(`${at}.previousItems`, invalid(`${at}.previousItems`));
	return defined({
		previousItems: mapJsonIds(Array.isArray(entry.previousItems) ? entry.previousItems : []),
		previousComboInfo: jsonOrNull(entry.previousComboInfo),
		editedBy: required(`${at}.editedBy`, entry.editedBy, { trim: false }),
		editedAt: checkDate(problems, `${at}.editedAt`, entry.editedAt),
		reason: required(`${at}.reason`, entry.reason, { max: 200, maxMessage: 'Lý do không được vượt quá 200 ký tự' })
	});
}

function itemData(problems, item, at) {
	const { text, required, number, id } = checks(problems);
	return defined({
		productId: id(`${at}.productId`, item.productId, { required: true }),
		productName: required(`${at}.productName`, item.productName, { trim: false }),
		price: number(`${at}.price`, given(item.price), { required: true, requiredMessage: requiredMessage(`${at}.price`), min: 0, minMessage: invalid(`${at}.price`), integer: true, integerMessage: invalid(`${at}.price`) }),
		quantity: number(`${at}.quantity`, given(item.quantity), { required: true, requiredMessage: requiredMessage(`${at}.quantity`), min: 1, minMessage: invalid(`${at}.quantity`), integer: true, integerMessage: invalid(`${at}.quantity`) }),
		fromCombo: checkBoolean(problems, `${at}.fromCombo`, item.fromCombo),
		comboId: id(`${at}.comboId`, item.comboId),
		comboName: text(`${at}.comboName`, item.comboName, {})
	});
}

/** Rows for a list field: each entry through `build`, a non-array refused. */
function rowsOf(problems, list, name, build) {
	if (list === undefined || list === null) return [];
	if (!Array.isArray(list)) {
		problems.add(name, invalid(name));
		return [];
	}
	return list.map((entry, index) => {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			problems.add(`${name}.${index}`, invalid(`${name}.${index}`));
			return {};
		}
		return build(problems, entry, `${name}.${index}`);
	});
}

/** @throws {RecordValidationError} */
function lineRows(list) {
	const problems = new Problems();
	const rows = rowsOf(problems, list, 'items', itemData);
	problems.throwIfAny();
	return rows;
}

/** @throws {RecordValidationError} */
function historyRow(entry) {
	const problems = new Problems();
	const row = historyData(problems, entry);
	problems.throwIfAny();
	return row;
}

/** @throws {RecordValidationError} */
function noteRow(entry) {
	const problems = new Problems();
	const row = noteData(problems, entry);
	problems.throwIfAny();
	return row;
}

/** @throws {RecordValidationError} */
function editRow(entry) {
	const problems = new Problems();
	const row = editData(problems, entry);
	problems.throwIfAny();
	return row;
}

/** The additional note of an edit, cleaned. @throws {RecordValidationError} */
function additionalNoteOf(value) {
	const problems = new Problems();
	const note = checkText(problems, 'additionalNote', value, noteRules);
	problems.throwIfAny();
	return note;
}

/**
 * Columns and child rows of a new order, applying the schema's rules.
 *
 * @param {object} fields
 * @returns {{columns: object, items: object[], statusHistory: object[], internalNotes: object[], itemsEdits: object[]}}
 * @throws {RecordValidationError}
 */
function newOrder(fields) {
	const problems = new Problems();
	const { text, required, number, id } = checks(problems);
	const direct = fields.isDirectSale === true;
	// Customer details are required for a web order and optional for a counter sale.
	const customer = (name, value, rules) => (direct ? text(name, value, rules) : required(name, value, rules));

	const orderCode = required('orderCode', fields.orderCode, { max: 10, maxMessage: tooLong('orderCode', 10) });
	const email = customer('email', fields.email, {});
	if (typeof email === 'string' && email !== '' && !direct && !EMAIL.test(email.toLowerCase())) problems.add('email', 'Email không hợp lệ');
	const phoneNumber = customer('phoneNumber', fields.phoneNumber, { max: 10, maxMessage: 'Số điện thoại không được vượt quá 10 ký tự' });
	if (typeof phoneNumber === 'string' && phoneNumber !== '' && !PHONE.test(phoneNumber)) problems.add('phoneNumber', 'Số điện thoại không hợp lệ');

	const columns = defined({
		orderCode: typeof orderCode === 'string' ? orderCode.toUpperCase() : orderCode,
		orderNumber: text('orderNumber', fields.orderNumber, {}),
		// An empty phone is not a phone: the CHECK on the column would refuse '' where Mongoose stored it.
		phoneNumber: phoneNumber === '' ? null : phoneNumber,
		studentId: customer('studentId', fields.studentId, { max: 20, maxMessage: 'Mã số sinh viên không được vượt quá 20 ký tự' }),
		fullName: customer('fullName', fields.fullName, { max: 100, maxMessage: 'Họ tên không được vượt quá 100 ký tự' }),
		email: typeof email === 'string' ? email.toLowerCase() : email,
		additionalNote: text('additionalNote', fields.additionalNote, noteRules),
		totalAmount: number('totalAmount', given(fields.totalAmount), { required: true, requiredMessage: requiredMessage('totalAmount'), min: 0, minMessage: invalid('totalAmount'), integer: true, integerMessage: invalid('totalAmount') }),
		...statusColumns(problems, fields),
		stockDeducted: checkBoolean(problems, 'stockDeducted', fields.stockDeducted ?? undefined),
		itemsRevision: number('itemsRevision', fields.itemsRevision ?? undefined, { min: 0, minMessage: invalid('itemsRevision'), integer: true, integerMessage: invalid('itemsRevision') }),
		isDirectSale: checkBoolean(problems, 'isDirectSale', fields.isDirectSale ?? undefined),
		createdBy: id('createdBy', fields.createdBy),
		storefrontId: id('storefrontId', fields.storefrontId),
		comboInfo: jsonOrNull(fields.comboInfo)
	});

	const items = rowsOf(problems, fields.items, 'items', itemData);
	const statusHistory = rowsOf(problems, fields.statusHistory, 'statusHistory', historyData);
	const internalNotes = rowsOf(problems, fields.internalNotes, 'internalNotes', noteData);
	const itemsEdits = rowsOf(problems, fields.itemsHistory, 'itemsHistory', editData);
	problems.throwIfAny();
	return { columns, items, statusHistory, internalNotes, itemsEdits };
}

module.exports = {
	STATUS_VALUES, newOrder, lineRows, statusChangeColumns, historyRow, noteRow, editRow, additionalNoteOf, jsonOrNull
};
