/**
 * The backup file ("snapshot") of the store's business data, independent of the
 * storage engine: its format, the checks a file must pass before anything is
 * deleted, and the total rule of a stored order.
 *
 * Wire form: every record is a complete JSON document. Ids are 24-hex strings,
 * dates are ISO strings, nothing is renamed. An engine's repository
 * (`data/<engine>/data-snapshot.js`) turns its rows into this form and back; this
 * file never touches a database.
 *
 * Fields outside a collection's list are rejected, not dropped: the restore
 * writes whole rows, so an unknown key must stop the file instead of being
 * written (or silently lost).
 */
const { isRecordId } = require('./ids');
const { PUBLIC_CODE_PATTERN } = require('../utils/public-code');

const SNAPSHOT_FORMAT_VERSION = 2;

/** Sections of `data`, in the order a restore writes them. */
const SNAPSHOT_SECTIONS = ['products', 'combos', 'orders', 'stockMovements', 'settings'];

// Login material belongs to the auth library, not to this file. A file that
// carries one of these sections is refused (restore) or reported (merge import)
// instead of being silently ignored.
const CREDENTIAL_SECTIONS = {
	users: 'Người dùng không thể import qua file vì lý do bảo mật. Tạo tài khoản qua giao diện quản trị.',
	accounts: 'Tài khoản đăng nhập không thể import qua file vì lý do bảo mật. Tạo tài khoản qua giao diện quản trị.',
	sessions: 'Phiên đăng nhập không thể import qua file vì lý do bảo mật.',
	jwks: 'Khoá ký token không thể import qua file vì lý do bảo mật.'
};

const MAX_REPORTED_PROBLEMS = 50;

// ---- field checks: (value, where, problems) -> pushes a message on failure ----

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const leaf = (test, hint) => (value, where, problems) => {
	if (!test(value)) problems.push(`${where} ${hint}`);
};

const id = leaf((v) => typeof v === 'string' && isRecordId(v), 'phải là mã 24 ký tự hex');
const bool = leaf((v) => typeof v === 'boolean', 'phải là true/false');
const date = leaf((v) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)), 'phải là ngày giờ ISO');

// Mixed fields (`comboInfo` and the item sets in `itemsHistory`) have no schema, so
// their shape is bounded here instead: the code that revives ids and restores
// nulls (data/<engine>/data-snapshot.js) recurses over them and relies on this
// cap, and a `$` or dotted key would be an operator or path once it reached a
// query. Real values are a few levels deep.
const MAX_MIXED_DEPTH = 8;
const UNSAFE_MIXED_KEY = /^\$|\.|^__proto__$/;

const anything = (value, where, problems) => {
	const walk = (node, depth) => {
		if (node === null || typeof node !== 'object') return true;
		if (depth > MAX_MIXED_DEPTH) {
			problems.push(`${where} lồng quá sâu (tối đa ${MAX_MIXED_DEPTH} cấp)`);
			return false;
		}
		if (Array.isArray(node)) return node.every((item) => walk(item, depth + 1));
		for (const [key, inner] of Object.entries(node)) {
			if (UNSAFE_MIXED_KEY.test(key)) {
				problems.push(`${where}: khoá "${key}" không hợp lệ`);
				return false;
			}
			if (!walk(inner, depth + 1)) return false;
		}
		return true;
	};
	walk(value, 0);
};
const text = (max) => leaf((v) => typeof v === 'string' && v.length <= max, `phải là chuỗi tối đa ${max} ký tự`);
const whole = (min) => leaf((v) => Number.isSafeInteger(v) && v >= min, min === 0 ? 'phải là số nguyên không âm' : `phải là số nguyên từ ${min}`);
const anyWhole = leaf(Number.isSafeInteger, 'phải là số nguyên');
const number = (min = -Infinity) => leaf(
	(v) => typeof v === 'number' && Number.isFinite(v) && v >= min,
	min === -Infinity ? 'phải là số' : `phải là số từ ${min}`
);
const oneOf = (values) => leaf((v) => values.includes(v), `phải là một trong: ${values.join(', ')}`);

const listOf = (check) => (value, where, problems) => {
	if (!Array.isArray(value)) {
		problems.push(`${where} phải là một mảng`);
		return;
	}
	value.forEach((item, index) => check(item, `${where}[${index}]`, problems));
};

/**
 * `fields`: key -> check. Keys in `required` must be present and non-null; any
 * other key may be absent or null (a stored null is kept as it is).
 */
const record = (fields, required = []) => (value, where, problems) => {
	if (!isObject(value)) {
		problems.push(`${where} phải là một object`);
		return;
	}
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(fields, key)) problems.push(`${where}: trường "${key}" không được nhận diện`);
	}
	for (const key of required) {
		if (value[key] === undefined || value[key] === null) problems.push(`${where}: thiếu "${key}"`);
	}
	for (const [key, check] of Object.entries(fields)) {
		if (value[key] === undefined || (value[key] === null && !required.includes(key))) continue;
		check(value[key], `${where}.${key}`, problems);
	}
};

const SALES_CHANNELS = ['all', 'online', 'offline'];
const ORDER_STATUSES = ['confirmed', 'paid', 'delivered', 'cancelled'];
const MOVEMENT_TYPES = ['opening', 'order', 'order_cancel', 'order_edit', 'adjust', 'set_target'];
const MOVEMENT_STATUSES = ['pending', 'applied'];

const stamps = { _id: id, createdAt: date, updatedAt: date, __v: whole(0) };

const PUBLIC_CODE = leaf((v) => typeof v === 'string' && PUBLIC_CODE_PATTERN.test(v), 'không phải mã công khai hợp lệ');

const productShape = record({
	...stamps,
	publicCode: PUBLIC_CODE,
	slug: text(200),
	name: text(100),
	description: text(500),
	price: whole(0),
	imageUrl: text(2000),
	category: text(200),
	available: bool,
	isActive: bool,
	salesChannel: oneOf(SALES_CHANNELS),
	stockQuantity: anyWhole,
	minOrderQuantity: whole(1),
	maxOrderQuantity: whole(0),
	sku: text(200),
	tags: listOf(text(200)),
	weight: number(0),
	dimensions: record({ length: number(), width: number(), height: number() }),
	featured: bool,
	salePrice: whole(0),
	saleStartDate: date,
	saleEndDate: date
}, ['_id', 'name', 'price', 'category']);

const comboShape = record({
	...stamps,
	publicCode: PUBLIC_CODE,
	slug: text(200),
	name: text(100),
	description: text(500),
	price: whole(0),
	categoryRequirements: listOf(record({ _id: id, category: text(200), quantity: whole(1) }, ['category', 'quantity'])),
	isActive: bool,
	salesChannel: oneOf(SALES_CHANNELS),
	priority: number()
}, ['_id', 'name', 'price', 'categoryRequirements']);

const orderItemShape = record({
	_id: id,
	productId: id,
	productName: text(500),
	price: whole(0),
	quantity: whole(1),
	fromCombo: bool,
	comboId: id,
	comboName: text(500)
}, ['productId', 'productName', 'price', 'quantity']);

const orderShape = record({
	...stamps,
	phoneNumber: text(10),
	orderCode: text(10),
	orderNumber: text(100),
	studentId: text(20),
	fullName: text(100),
	email: text(254),
	additionalNote: text(500),
	items: listOf(orderItemShape),
	totalAmount: whole(0),
	status: oneOf(ORDER_STATUSES),
	stockDeducted: bool,
	transactionCode: text(50),
	cancelReason: text(500),
	statusHistory: listOf(record({
		_id: id,
		status: oneOf(ORDER_STATUSES),
		updatedBy: text(200),
		updatedAt: date,
		transactionCode: text(50),
		cancelReason: text(500),
		note: text(500)
	}, ['status', 'updatedBy'])),
	internalNotes: listOf(record({ note: text(500), by: text(200), at: date }, ['note', 'by'])),
	itemsRevision: whole(0),
	itemsHistory: listOf(record({
		previousItems: listOf(anything),
		previousComboInfo: anything,
		editedBy: text(200),
		editedAt: date,
		reason: text(200)
	}, ['editedBy', 'reason'])),
	lastUpdatedBy: text(200),
	statusUpdatedAt: date,
	isDirectSale: bool,
	createdBy: id,
	comboInfo: anything
}, ['_id', 'orderCode', 'totalAmount']);

const movementShape = record({
	_id: id,
	createdAt: date,
	__v: whole(0),
	productId: id,
	type: oneOf(MOVEMENT_TYPES),
	delta: anyWhole,
	target: anyWhole,
	orderId: id,
	reason: text(200),
	createdBy: text(200),
	idempotencyKey: text(200),
	status: oneOf(MOVEMENT_STATUSES),
	appliedAt: date,
	stockAfter: anyWhole,
	claimedAt: date,
	attempts: whole(0),
	lastError: text(2000)
}, ['_id', 'productId', 'type', 'idempotencyKey', 'status']);

const settingsShape = record({
	...stamps,
	key: text(100),
	bankNameId: text(200),
	bankAccountId: text(200),
	prefixMessage: text(200),
	storeTitle: text(60),
	checkoutNotice: text(5000),
	eventNotice: text(5000),
	paymentNotice: text(5000),
	contactEmail: text(254),
	contactFacebookUrl: text(500),
	updatedBy: text(200)
}, ['_id', 'bankNameId', 'bankAccountId']);

const SHAPES = {
	products: productShape,
	combos: comboShape,
	orders: orderShape,
	stockMovements: movementShape,
	settings: settingsShape
};

// ---- order total rule ----

/** Σ price × quantity over `items`; the total of an order without combos. */
function sumLines(items) {
	if (!Array.isArray(items)) return 0;
	return items.reduce((sum, item) => sum + (Number(item?.price) || 0) * (Number(item?.quantity) || 0), 0);
}

/**
 * The total a stored order must carry, from its own lines.
 *
 * An order with `comboInfo` is `comboInfo.finalTotal` plus the lines that do not
 * come from a combo: combo lines keep their retail unit price for display, so
 * summing every line would count the combo's discount away. Orders are created
 * under exactly this identity (services/pricing.js).
 *
 * @returns {number|null} null when `comboInfo.finalTotal` is not a finite number
 */
function storedOrderTotal({ items, comboInfo }) {
	if (!comboInfo) return sumLines(items);
	const finalTotal = Number(comboInfo.finalTotal);
	if (!Number.isFinite(finalTotal)) return null;
	return finalTotal + sumLines(Array.isArray(items) ? items.filter((item) => !item?.fromCombo) : []);
}

// ---- whole-file checks ----

function checkUnique(records, field, where, problems) {
	const seen = new Set();
	records.forEach((row, index) => {
		const value = row && row[field];
		if (typeof value !== 'string') return;
		if (seen.has(value)) problems.push(`${where}[${index}].${field} bị trùng trong file`);
		seen.add(value);
	});
}

function checkOrderTotals(orders, problems) {
	orders.forEach((order, index) => {
		if (!isObject(order) || !Number.isSafeInteger(order.totalAmount)) return;
		const expected = storedOrderTotal(order);
		const where = `orders[${index}]`;
		if (expected === null) {
			problems.push(`${where}.comboInfo.finalTotal không hợp lệ`);
		} else if (expected !== order.totalAmount) {
			problems.push(`${where} (${order.orderCode}): tổng tiền ${order.totalAmount} không khớp với các dòng hàng (${expected})`);
		}
	});
}

/**
 * Check a v2 file's `metadata` and `data` before anything is written.
 *
 * What it can see is the file alone. Order lines and movements may point at a
 * product that is not in the file: orders outlive deleted products, and a
 * movement of a deleted product is closed by the ledger as `PRODUCT_NOT_FOUND`.
 * The stock cache against the ledger is checked after the rows are written
 * (`reconcile`), where the store can answer it.
 *
 * @param {unknown} metadata
 * @param {unknown} data
 * @returns {string[]} Vietnamese problem lines; empty when the file is acceptable
 */
function validateSnapshot(metadata, data) {
	const problems = [];
	if (!isObject(data)) return ['"data" phải là một object'];

	for (const section of Object.keys(data)) {
		if (Object.hasOwn(CREDENTIAL_SECTIONS, section)) {
			problems.push(`Phần "${section}" không được phép có trong file khôi phục: ${CREDENTIAL_SECTIONS[section]}`);
		} else if (!SNAPSHOT_SECTIONS.includes(section)) {
			problems.push(`Không nhận diện được phần "${section}"`);
		}
	}

	for (const section of SNAPSHOT_SECTIONS) {
		const rows = data[section];
		if (!Array.isArray(rows)) {
			problems.push(`Phần "${section}" phải có và là một mảng`);
			continue;
		}
		rows.forEach((row, index) => SHAPES[section](row, `${section}[${index}]`, problems));
		if (problems.length > MAX_REPORTED_PROBLEMS) break;
		checkUnique(rows, '_id', section, problems);
	}

	if (Array.isArray(data.stockMovements)) checkUnique(data.stockMovements, 'idempotencyKey', 'stockMovements', problems);
	if (Array.isArray(data.settings) && data.settings.length > 1) problems.push('Phần "settings" chỉ được có tối đa một bản ghi');
	if (Array.isArray(data.orders)) checkOrderTotals(data.orders, problems);

	const counts = isObject(metadata) ? metadata.collections : undefined;
	if (!isObject(counts)) {
		problems.push('metadata.collections là bắt buộc');
	} else {
		for (const section of SNAPSHOT_SECTIONS) {
			if (Array.isArray(data[section]) && counts[section] !== data[section].length) {
				problems.push(`metadata.collections.${section} (${counts[section]}) không khớp số bản ghi trong file (${data[section].length})`);
			}
		}
	}

	if (problems.length > MAX_REPORTED_PROBLEMS) {
		const extra = problems.length - MAX_REPORTED_PROBLEMS;
		return [...problems.slice(0, MAX_REPORTED_PROBLEMS), `… và ${extra} lỗi khác`];
	}
	return problems;
}

/**
 * The file's `metadata` for `data`.
 *
 * @param {Record<string, Array>} data
 * @param {Date} now
 */
function buildMetadata(data, now) {
	return {
		formatVersion: SNAPSHOT_FORMAT_VERSION,
		exportedAt: now.toISOString(),
		collections: Object.fromEntries(SNAPSHOT_SECTIONS.map((section) => [section, data[section].length]))
	};
}

module.exports = {
	SNAPSHOT_FORMAT_VERSION,
	CREDENTIAL_SECTIONS,
	storedOrderTotal,
	validateSnapshot,
	buildMetadata
};
