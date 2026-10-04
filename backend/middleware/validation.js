const { body, param, validationResult } = require('express-validator');
const { STUDENT_ID_PATTERN } = require('../utils/student-id');
const { createPasswordValidationRules } = require('../utils/passwordValidator');
const { MAX_UNITS_PER_ORDER } = require('../services/pricing');

// Field names whose rejected value must never be echoed back in a 400 body —
// a wrong password would otherwise appear verbatim in the response.
const SENSITIVE_FIELDS = ['password', 'token', 'secret', 'apikey', 'creditcard'];
const isSensitiveField = (field) =>
	SENSITIVE_FIELDS.some((s) => String(field).toLowerCase().includes(s));

/**
 * Handle validation errors
 */
const handleValidationErrors = (req, res, next) => {
	const errors = validationResult(req);

	if (!errors.isEmpty()) {
		return res.status(400).json({
			message: 'Dữ liệu không hợp lệ',
			errors: errors.array().map(error => ({
				field: error.path,
				message: error.msg,
				...(isSensitiveField(error.path) ? {} : { value: error.value })
			}))
		});
	}

	next();
};

/**
 * The total the client displayed. Mandatory so an order can never be placed
 * without the customer having seen a price (stale tabs get a clear 400);
 * the route compares it with the recomputed total and answers 409 on mismatch.
 */
const expectedTotalRule = body('expectedTotal')
	.exists({ values: 'null' })
	.withMessage('Thiếu tổng tiền hiển thị, vui lòng tải lại trang')
	.bail()
	.custom((value) => Number.isInteger(value) && value >= 0)
	.withMessage('Tổng tiền hiển thị không hợp lệ');

/**
 * Validation rules for a counter (direct) sale. Item shape and availability
 * are checked by the route and the pricing engine.
 */
const validateDirectOrder = [expectedTotalRule, handleValidationErrors];

/**
 * Validation rules for creating an order
 */
const validateOrder = [
	body('studentId')
		.trim()
		.notEmpty()
		.withMessage('Mã số sinh viên là bắt buộc')
		.matches(STUDENT_ID_PATTERN)
		.withMessage('Mã số sinh viên gồm 8 chữ số, từ 16xxxxxx đến 26xxxxxx'),

	body('fullName')
		.notEmpty()
		.withMessage('Họ tên là bắt buộc')
		.isLength({ min: 2, max: 100 })
		.withMessage('Họ tên phải từ 2-100 ký tự')
		.matches(/^[a-zA-ZÀ-ỹ\s]+$/)
		.withMessage('Họ tên chỉ được chứa chữ cái và khoảng trắng')
		.trim(),

	body('email')
		.isEmail()
		.withMessage('Email không hợp lệ')
		// No .normalizeEmail(): it mutated the stored value (e.g. lower-cased,
		// stripped dots for gmail) so the email on the order no longer matched
		// what the customer typed or what admin search later looks up.
		.isLength({ max: 100 })
		.withMessage('Email không được vượt quá 100 ký tự'),

	body('phoneNumber')
		.notEmpty()
		.withMessage('Số điện thoại là bắt buộc')
		.matches(/^0[0-9]{9}$/)
		.withMessage('Số điện thoại phải có 10 số và bắt đầu bằng 0')
		.trim(),

	body('additionalNote')
		.optional()
		.isLength({ max: 500 })
		.withMessage('Ghi chú không được vượt quá 500 ký tự')
		.trim(),

	body('items')
		.isArray({ min: 1 })
		.withMessage('Đơn hàng phải có ít nhất 1 sản phẩm'),

	body('items.*.productId')
		.isMongoId()
		.withMessage('ID sản phẩm không hợp lệ'),

	body('items.*.quantity')
		.isInt({ min: 1, max: 100 })
		.withMessage('Số lượng phải từ 1-100'),

	expectedTotalRule,

	handleValidationErrors
];

/**
 * Validation rules for updating order status
 */
const validateOrderUpdate = [
	body('status')
		.isIn(['confirmed', 'paid', 'delivered', 'cancelled'])
		.withMessage('Trạng thái không hợp lệ'),

	body('transactionCode')
		.optional()
		.isLength({ max: 50 })
		.withMessage('Mã giao dịch không được vượt quá 50 ký tự')
		.trim(),

	body('cancelReason')
		.optional()
		.isLength({ max: 500 })
		.withMessage('Lý do hủy không được vượt quá 500 ký tự')
		.trim(),

	body('note')
		.optional()
		.isLength({ max: 500 })
		.withMessage('Ghi chú không được vượt quá 500 ký tự')
		.trim(),

	handleValidationErrors
];

// `additionalNote` may be empty (clears the customer note); `note` may not.
const validateOrderItemsEdit = [
	param('id').isMongoId().withMessage('ID đơn hàng không hợp lệ'),

	body('items')
		.isArray({ min: 1, max: 50 })
		.withMessage('Danh sách sản phẩm phải có từ 1 đến 50 dòng'),
	body('items.*.productId')
		.isMongoId()
		.withMessage('ID sản phẩm không hợp lệ'),
	body('items.*.quantity')
		.isInt({ min: 1 })
		.withMessage('Số lượng phải là số nguyên từ 1 trở lên')
		.bail()
		.toInt(),

	body('expectedRevision')
		.isInt({ min: 0 })
		.withMessage('expectedRevision phải là số nguyên không âm')
		.bail()
		.toInt(),

	body('reason')
		.isString()
		.withMessage('Lý do không hợp lệ')
		.bail()
		.trim()
		.isLength({ min: 1, max: 200 })
		.withMessage('Lý do phải từ 1 đến 200 ký tự'),

	handleValidationErrors
];

const validateOrderNotes = [
	param('id').isMongoId().withMessage('ID đơn hàng không hợp lệ'),

	body('additionalNote')
		.optional()
		.isString()
		.withMessage('Ghi chú khách hàng không hợp lệ')
		.bail()
		.trim()
		.isLength({ max: 500 })
		.withMessage('Ghi chú không được vượt quá 500 ký tự'),

	body('note')
		.optional()
		.isString()
		.withMessage('Ghi chú nội bộ không hợp lệ')
		.bail()
		.trim()
		.isLength({ min: 1, max: 500 })
		.withMessage('Ghi chú nội bộ phải từ 1 đến 500 ký tự'),

	body().custom((value) => {
		if (value?.additionalNote === undefined && value?.note === undefined) {
			throw new Error('Cần ít nhất một trong additionalNote hoặc note');
		}
		return true;
	}),

	handleValidationErrors
];

// validateSellerLogin removed - now handled by better-auth
// The old search-parameter validator was removed: it was mounted on 0
// routes, and read req.body while every caller reads req.query — dead for
// two independent reasons. Query input is guarded by utils/query-guard.js.

/**
 * Validation rules for the public cart preview (/combos/pricing).
 * Bounds the array so an anonymous caller cannot force an unbounded product
 * lookup, and bounds quantity so it cannot reach Infinity/NaN territory in
 * downstream pricing math. The order-wide unit cap is enforced by the pricing
 * engine, which sees lines after merging duplicates.
 */
const validateComboItems = [
	body('items')
		.isArray({ min: 1, max: 100 })
		.withMessage('Danh sách sản phẩm phải có từ 1 đến 100 mục'),

	body('items.*.productId')
		.isMongoId()
		.withMessage('ID sản phẩm không hợp lệ'),

	body('items.*.quantity')
		.isInt({ min: 1, max: MAX_UNITS_PER_ORDER })
		.withMessage(`Số lượng phải từ 1-${MAX_UNITS_PER_ORDER}`)
		.toInt(),

	handleValidationErrors
];

/**
 * Validation rules for changing password
 */
const validatePasswordChange = [
	body('currentPassword')
		.notEmpty()
		.withMessage('Mật khẩu hiện tại là bắt buộc')
		.trim(),

	...createPasswordValidationRules('newPassword'),

	handleValidationErrors
];

/**
 * Validation rules for user signup/registration  
 */
const validateUserRegistration = [
	body('email')
		.isEmail()
		.withMessage('Email không hợp lệ')
		.isLength({ max: 100 })
		.withMessage('Email không được vượt quá 100 ký tự'),

	body('username')
		.notEmpty()
		.withMessage('Tên đăng nhập là bắt buộc')
		.isLength({ min: 3, max: 30 })
		.withMessage('Tên đăng nhập phải từ 3-30 ký tự')
		.matches(/^[a-zA-Z0-9_]+$/)
		.withMessage('Tên đăng nhập chỉ được chứa chữ cái, số và dấu gạch dưới')
		.trim(),

	body('name')
		.notEmpty()
		.withMessage('Họ tên là bắt buộc')
		.isLength({ min: 2, max: 100 })
		.withMessage('Họ tên phải từ 2-100 ký tự')
		.matches(/^[a-zA-ZÀ-ỹ\s]+$/)
		.withMessage('Họ tên chỉ được chứa chữ cái và khoảng trắng')
		.trim(),

	...createPasswordValidationRules('password'),

	handleValidationErrors
];

/**
 * Validation rules for password reset
 */
const validatePasswordReset = [
	body('token')
		.notEmpty()
		.withMessage('Token đặt lại mật khẩu là bắt buộc')
		.trim(),

	...createPasswordValidationRules('newPassword'),

	handleValidationErrors
];

module.exports = {
	validateOrder,
	validateDirectOrder,
	validateOrderUpdate,
	validateOrderNotes,
	validateOrderItemsEdit,
	validateComboItems,
	validatePasswordChange,
	validateUserRegistration,
	validatePasswordReset,
	handleValidationErrors
};
