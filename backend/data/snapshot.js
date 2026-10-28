/**
 * The backup file ("snapshot") of the store's business data, independent of the
 * storage engine: its format, the checks a file must pass before anything is
 * deleted, and the total rule of a stored order.
 *
 * Wire form: every record is a complete JSON document. Ids are record ids (uuid
 * strings; a file made before the move to Postgres holds 24-hex ids instead),
 * dates are ISO strings, nothing is renamed. An engine's repository
 * (`data/<engine>/data-snapshot.js`) turns its rows into this form and back; this
 * file never touches a database. The restore maps legacy 24-hex ids to uuids, so
 * an old backup file still loads.
 *
 * Fields outside a collection's list are rejected, not dropped: the restore
 * writes whole rows, so an unknown key must stop the file instead of being
 * written (or silently lost).
 *
 * Storefronts: a file made before they existed has none of the four storefront
 * sections and no storefront field on a row, and restores into the default
 * storefront. A file that has any of them must have all four, each row's
 * references must resolve inside the file, and nothing may name a storefront the
 * file does not hold: the restore deletes every storefront, so a dangling
 * reference could not be repaired afterwards.
 *
 * Variants: a product row carries `images`, `options` and `variants` (all three or
 * none, and every product alike). A file made before variants existed has none,
 * and restores with one default variant per product holding its stock, every
 * order line and movement of the product pointed at it. In a file that has them,
 * an order line or movement of a product in the file must name one of that
 * product's variants. Stock against the ledger is checked after the rows are
 * written (`reconcile`), as for products.
 */
const { isRecordId, normalizeRecordId } = require('./ids');
const { PUBLIC_CODE_PATTERN } = require('../utils/public-code');

const SNAPSHOT_FORMAT_VERSION = 2;

/** Sections every file has, in the order a restore writes them. */
const SNAPSHOT_SECTIONS = ['products', 'combos', 'orders', 'stockMovements', 'settings'];

/** Sections a file made after storefronts existed adds (all four or none). */
const STOREFRONT_SECTIONS = ['storefronts', 'storefrontAccessRules', 'emailLists', 'emailListEntries'];

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

const id = leaf((v) => typeof v === 'string' && isRecordId(v), 'phải là mã bản ghi hợp lệ');
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

const VISIBILITIES = ['PUBLIC', 'PRIVATE'];
const RULE_TYPES = ['EMAIL', 'DOMAIN', 'LIST'];

const stamps = { _id: id, createdAt: date, updatedAt: date, __v: whole(0) };

const lowercase = (max) => leaf(
	(v) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.toLowerCase(),
	`phải là chuỗi chữ thường, tối đa ${max} ký tự`
);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = leaf((v) => typeof v === 'string' && v.length <= 60 && SLUG_PATTERN.test(v), 'phải là đường dẫn hợp lệ (chữ thường, số, gạch ngang)');
const int32 = leaf((v) => Number.isSafeInteger(v) && Math.abs(v) <= 2147483647, 'phải là số nguyên 32 bit');
const EMAIL_SHAPE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
const DOMAIN_SHAPE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const email = leaf((v) => typeof v === 'string' && v.length <= 254 && v === v.toLowerCase() && EMAIL_SHAPE.test(v), 'phải là email chữ thường hợp lệ');

const PUBLIC_CODE = leaf((v) => typeof v === 'string' && PUBLIC_CODE_PATTERN.test(v), 'không phải mã công khai hợp lệ');

const variantShape = record({
	_id: id,
	optionValues: listOf(text(30)),
	price: whole(0),
	sku: text(200),
	imageUrl: text(2000),
	isActive: bool,
	archivedAt: date,
	stockQuantity: anyWhole
}, ['_id', 'optionValues', 'stockQuantity']);

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
	saleEndDate: date,
	storefrontId: id,
	images: listOf(text(2000)),
	options: listOf(record({ name: text(30), values: listOf(text(30)) }, ['name', 'values'])),
	variants: listOf(variantShape)
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
	priority: number(),
	storefrontIds: listOf(id)
}, ['_id', 'name', 'price', 'categoryRequirements']);

const orderItemShape = record({
	_id: id,
	productId: id,
	productName: text(500),
	price: whole(0),
	quantity: whole(1),
	fromCombo: bool,
	comboId: id,
	comboName: text(500),
	variantId: id,
	variantLabel: text(200)
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
	comboInfo: anything,
	storefrontId: id
}, ['_id', 'orderCode', 'totalAmount']);

const movementShape = record({
	_id: id,
	createdAt: date,
	__v: whole(0),
	productId: id,
	variantId: id,
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
	googleClientId: text(200),
	updatedBy: text(200)
}, ['_id', 'bankNameId', 'bankAccountId']);

const storefrontShape = record({
	...stamps,
	slug,
	name: text(80),
	description: text(500),
	visibility: oneOf(VISIBILITIES),
	sortOrder: int32,
	isActive: bool
}, ['_id', 'slug', 'name', 'visibility']);

const accessRuleShape = record({
	_id: id,
	storefrontId: id,
	type: oneOf(RULE_TYPES),
	value: lowercase(254),
	emailListId: id,
	createdBy: id,
	createdAt: date
}, ['_id', 'storefrontId', 'type']);

const emailListShape = record({
	...stamps,
	name: text(80),
	description: text(500)
}, ['_id', 'name']);

const emailListEntryShape = record({
	_id: id,
	emailListId: id,
	email,
	createdAt: date
}, ['_id', 'emailListId', 'email']);

const SHAPES = {
	products: productShape,
	combos: comboShape,
	orders: orderShape,
	stockMovements: movementShape,
	settings: settingsShape,
	storefronts: storefrontShape,
	storefrontAccessRules: accessRuleShape,
	emailLists: emailListShape,
	emailListEntries: emailListEntryShape
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

function checkUniqueBy(rows, keyOf, label, where, problems) {
	const seen = new Set();
	rows.forEach((row, index) => {
		const key = isObject(row) ? keyOf(row) : null;
		if (key === null) return;
		if (seen.has(key)) problems.push(`${where}[${index}] bị trùng ${label} trong file`);
		seen.add(key);
	});
}

// The canonical form of an id, or null for a value the field check already reported.
const canonicalId = (value) => {
	try {
		return normalizeRecordId(value);
	} catch {
		return null;
	}
};

const idsOf = (rows) => new Set(rows.filter(isObject).map((row) => canonicalId(row._id)).filter((key) => key !== null));

const isGiven = (value) => value !== undefined && value !== null;

/** A file without the storefront sections must not name a storefront anywhere. */
function checkNoStorefrontFields(data, problems) {
	const stray = (rows, field, where) => rows.forEach((row, index) => {
		if (isObject(row) && isGiven(row[field])) problems.push(`${where}[${index}]: trường "${field}" cần đi cùng các phần ${STOREFRONT_SECTIONS.join(', ')}`);
	});
	stray(data.products, 'storefrontId', 'products');
	stray(data.combos, 'storefrontIds', 'combos');
	stray(data.orders, 'storefrontId', 'orders');
}

/** Every reference inside the four storefront sections, and from products, combos and orders to them, resolves in the file. */
function checkStorefrontLinks(data, problems) {
	const storefronts = idsOf(data.storefronts);
	const lists = idsOf(data.emailLists);
	const refers = (value, known, where, label) => {
		const key = isGiven(value) ? canonicalId(value) : null;
		if (key !== null && !known.has(key)) problems.push(`${where} trỏ tới ${label} không có trong file`);
	};

	if (!data.storefronts.some((row) => isObject(row) && row.isActive !== false)) {
		problems.push('Phần "storefronts" phải có ít nhất một cửa hàng đang hoạt động');
	}
	checkUnique(data.storefronts, 'slug', 'storefronts', problems);
	checkUnique(data.emailLists, 'name', 'emailLists', problems);

	data.products.forEach((product, index) => {
		if (!isObject(product)) return;
		const where = `products[${index}].storefrontId`;
		if (!isGiven(product.storefrontId)) problems.push(`products[${index}]: thiếu "storefrontId"`);
		else refers(product.storefrontId, storefronts, where, 'cửa hàng');
	});

	data.combos.forEach((combo, index) => {
		if (!isObject(combo)) return;
		const where = `combos[${index}].storefrontIds`;
		if (!Array.isArray(combo.storefrontIds) || combo.storefrontIds.length === 0) {
			problems.push(`combos[${index}]: "storefrontIds" phải có ít nhất một cửa hàng`);
			return;
		}
		const keys = combo.storefrontIds.map(canonicalId);
		if (new Set(keys).size !== keys.length) problems.push(`${where} có cửa hàng bị lặp`);
		combo.storefrontIds.forEach((storefrontId, position) => refers(storefrontId, storefronts, `${where}[${position}]`, 'cửa hàng'));
	});

	data.orders.forEach((order, index) => {
		if (isObject(order)) refers(order.storefrontId, storefronts, `orders[${index}].storefrontId`, 'cửa hàng');
	});

	data.storefrontAccessRules.forEach((rule, index) => {
		if (!isObject(rule)) return;
		const where = `storefrontAccessRules[${index}]`;
		refers(rule.storefrontId, storefronts, `${where}.storefrontId`, 'cửa hàng');
		if (rule.type === 'LIST') {
			if (!isGiven(rule.emailListId)) problems.push(`${where}: quy tắc LIST thiếu "emailListId"`);
			else refers(rule.emailListId, lists, `${where}.emailListId`, 'danh sách email');
			if (isGiven(rule.value)) problems.push(`${where}: quy tắc LIST không có "value"`);
		} else if (rule.type === 'EMAIL' || rule.type === 'DOMAIN') {
			if (isGiven(rule.emailListId)) problems.push(`${where}: quy tắc ${rule.type} không dùng "emailListId"`);
			if (!isGiven(rule.value)) problems.push(`${where}: thiếu "value"`);
			else if (typeof rule.value === 'string' && !(rule.type === 'EMAIL' ? EMAIL_SHAPE : DOMAIN_SHAPE).test(rule.value)) {
				problems.push(`${where}.value không phải ${rule.type === 'EMAIL' ? 'email' : 'tên miền'} hợp lệ`);
			}
		}
	});
	checkUniqueBy(data.storefrontAccessRules, (rule) => {
		const storefrontId = canonicalId(rule.storefrontId);
		const target = rule.type === 'LIST' ? canonicalId(rule.emailListId) : rule.value;
		return storefrontId === null || !isGiven(target) ? null : `${storefrontId}|${rule.type}|${target}`;
	}, 'quy tắc', 'storefrontAccessRules', problems);

	data.emailListEntries.forEach((entry, index) => {
		if (isObject(entry)) refers(entry.emailListId, lists, `emailListEntries[${index}].emailListId`, 'danh sách email');
	});
	checkUniqueBy(data.emailListEntries, (entry) => {
		const listId = canonicalId(entry.emailListId);
		return listId === null || typeof entry.email !== 'string' ? null : `${listId}|${entry.email}`;
	}, 'email', 'emailListEntries', problems);
}

const VARIANT_FIELDS = ['images', 'options', 'variants'];
const MAX_IMAGES = 9;
const FALLBACK_IMAGE = '/fallback-product.png';

/** Variants are in the file (every product has them) or not at all; null when the products disagree. */
function variantsMode(products) {
	const rows = products.filter(isObject);
	const withAll = rows.filter((row) => VARIANT_FIELDS.every((field) => isGiven(row[field])));
	const withAny = rows.filter((row) => VARIANT_FIELDS.some((field) => isGiven(row[field])));
	if (withAny.length === 0) return 'legacy';
	return withAll.length === rows.length ? 'variants' : null;
}

/**
 * Variant rules a file must keep: each product has at least one variant, one value
 * per option and no repeated combination, at most nine images with the first one
 * as `imageUrl`; a movement of a product in the file names one of its variants,
 * and a line or movement of a product in the file names one of its variants. A
 * file without variants may not name one anywhere.
 */
function checkVariants(data, problems) {
	const mode = variantsMode(data.products);
	if (mode === null) {
		problems.push(`Mọi sản phẩm phải cùng có hoặc cùng không có ${VARIANT_FIELDS.join(', ')}`);
		return;
	}
	const productVariants = new Map();
	if (mode === 'variants') {
		const allIds = [];
		data.products.forEach((product, index) => {
			if (!isObject(product)) return;
			const where = `products[${index}]`;
			const { variants, options } = product;
			if (!Array.isArray(variants) || !Array.isArray(options)) return;
			if (variants.length === 0) problems.push(`${where}: phải có ít nhất một phân loại`);
			const combos = new Set();
			variants.forEach((variant, position) => {
				if (!isObject(variant) || !Array.isArray(variant.optionValues)) return;
				if (variant.optionValues.length !== options.length) problems.push(`${where}.variants[${position}]: số giá trị không khớp số loại phân loại`);
				const key = JSON.stringify(variant.optionValues);
				if (combos.has(key)) problems.push(`${where}.variants[${position}]: phân loại bị trùng`);
				combos.add(key);
				allIds.push({ _id: variant._id });
			});
			const productId = canonicalId(product._id);
			if (productId !== null) productVariants.set(productId, idsOf(variants));
			if (Array.isArray(product.images)) {
				if (product.images.length > MAX_IMAGES) problems.push(`${where}.images: tối đa ${MAX_IMAGES} ảnh`);
				const cover = product.images[0] ?? FALLBACK_IMAGE;
				if ((product.imageUrl ?? FALLBACK_IMAGE) !== cover) problems.push(`${where}.imageUrl phải là ảnh đầu tiên của images`);
			}
		});
		checkUnique(allIds, '_id', 'products[].variants', problems);
	}

	const names = (rows, where, field, required) => rows.forEach((row, index) => {
		if (!isObject(row)) return;
		if (!isGiven(row.variantId)) {
			// A movement must move some variant's stock; one of a product the file holds
			// would otherwise be settled as gone and its units lost.
			if (required && mode === 'variants' && productVariants.has(canonicalId(row[field]))) problems.push(`${where(index)}: thiếu "variantId"`);
			return;
		}
		if (mode === 'legacy') {
			problems.push(`${where(index)}: trường "variantId" cần đi cùng phân loại của sản phẩm`);
			return;
		}
		const known = productVariants.get(canonicalId(row[field]));
		if (known && !known.has(canonicalId(row.variantId))) problems.push(`${where(index)}.variantId không phải phân loại của sản phẩm`);
	});
	data.orders.forEach((order, orderIndex) => {
		if (isObject(order) && Array.isArray(order.items)) names(order.items, (index) => `orders[${orderIndex}].items[${index}]`, 'productId', false);
	});
	names(data.stockMovements, (index) => `stockMovements[${index}]`, 'productId', true);
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
		} else if (!SNAPSHOT_SECTIONS.includes(section) && !STOREFRONT_SECTIONS.includes(section)) {
			problems.push(`Không nhận diện được phần "${section}"`);
		}
	}

	const storefrontSections = STOREFRONT_SECTIONS.filter((section) => data[section] !== undefined);
	if (storefrontSections.length > 0 && storefrontSections.length < STOREFRONT_SECTIONS.length) {
		problems.push(`Các phần ${STOREFRONT_SECTIONS.join(', ')} phải đi cùng nhau`);
	}
	const sections = [...SNAPSHOT_SECTIONS, ...storefrontSections];

	for (const section of sections) {
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
	if (SNAPSHOT_SECTIONS.every((section) => Array.isArray(data[section]))) {
		checkVariants(data, problems);
		if (storefrontSections.length === STOREFRONT_SECTIONS.length && storefrontSections.every((section) => Array.isArray(data[section]))) checkStorefrontLinks(data, problems);
		else if (storefrontSections.length === 0) checkNoStorefrontFields(data, problems);
	}

	const counts = isObject(metadata) ? metadata.collections : undefined;
	if (!isObject(counts)) {
		problems.push('metadata.collections là bắt buộc');
	} else {
		for (const section of sections) {
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
		collections: Object.fromEntries([...SNAPSHOT_SECTIONS, ...STOREFRONT_SECTIONS.filter((section) => Array.isArray(data[section]))].map((section) => [section, data[section].length]))
	};
}

module.exports = {
	SNAPSHOT_FORMAT_VERSION,
	STOREFRONT_SECTIONS,
	CREDENTIAL_SECTIONS,
	storedOrderTotal,
	validateSnapshot,
	buildMetadata
};
