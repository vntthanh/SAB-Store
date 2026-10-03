const mongoose = require('mongoose');

const SETTINGS_KEY = 'payment_config';
// frontend/src/services/api.js repeats both store-title constants and
// NOTICE_MAX_LENGTH for the header fallback and the admin form's limits; keep
// them in sync.
const DEFAULT_STORE_TITLE = 'SAB Store';
const STORE_TITLE_MAX_LENGTH = 60;

// Customer-facing reminders, authored as Markdown by an admin. An empty string
// is a deliberate choice that hides the reminder box; only a missing field
// (a document saved before these existed) falls back to the default.
const NOTICE_MAX_LENGTH = 5000;
const DEFAULT_NOTICES = {
	checkoutNotice: [
		'- Vui lòng kiểm tra kỹ thông tin trước khi xác nhận',
		'- Sau khi xác nhận, bạn vui lòng quét mã chuyển khoản trong vòng 1 giờ',
		'- SAB sẽ gửi thông tin xác nhận thanh toán **trong vòng 7 ngày**',
		'- Thời gian nhận hàng dự kiến từ ngày T4 08/10/2025 đến ngày 19/10/2025 tại **Cơ sở 1 - 227 Nguyễn Văn Cừ, Phường Chợ Quán**'
	].join('\n'),
	eventNotice: [
		'- Vui lòng kiểm tra kỹ thông tin trước khi xác nhận.',
		'- Sau khi xác nhận, bạn vui lòng quét mã chuyển khoản trong vòng 1 giờ.'
	].join('\n'),
	paymentNotice: 'Để được xử lý nhanh nhất, bạn vui lòng thanh toán trong vòng 1 giờ'
};
const NOTICE_FIELDS = Object.keys(DEFAULT_NOTICES);

const noticeField = (field, description) => ({
	type: String,
	maxlength: NOTICE_MAX_LENGTH,
	default: DEFAULT_NOTICES[field],
	description
});

const settingsSchema = new mongoose.Schema({
	key: {
		type: String,
		required: true,
		unique: true,
		default: SETTINGS_KEY
	},
	bankNameId: {
		type: String,
		required: true,
		trim: true,
		description: 'Bank ID for VietQR (e.g., MB, VCB, TCB)'
	},
	bankAccountId: {
		type: String,
		required: true,
		trim: true,
		description: 'Bank account number'
	},
	prefixMessage: {
		type: String,
		required: true,
		trim: true,
		default: 'SAB',
		description: 'Prefix for payment messages'
	},
	storeTitle: {
		type: String,
		trim: true,
		minlength: 1,
		maxlength: STORE_TITLE_MAX_LENGTH,
		default: DEFAULT_STORE_TITLE,
		description: 'Store name shown in the public site header'
	},
	checkoutNotice: noticeField('checkoutNotice', 'Markdown reminder on the checkout page'),
	eventNotice: noticeField('eventNotice', 'Markdown reminder on the event order page'),
	paymentNotice: noticeField('paymentNotice', 'Markdown reminder above the payment QR code'),
	updatedAt: {
		type: Date,
		default: Date.now
	},
	updatedBy: {
		type: String,
		default: 'system'
	}
}, {
	timestamps: true
});

settingsSchema.pre('save', function (next) {
	this.updatedAt = Date.now();
	next();
});

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings;
module.exports.SETTINGS_KEY = SETTINGS_KEY;
module.exports.DEFAULT_STORE_TITLE = DEFAULT_STORE_TITLE;
module.exports.STORE_TITLE_MAX_LENGTH = STORE_TITLE_MAX_LENGTH;
module.exports.NOTICE_MAX_LENGTH = NOTICE_MAX_LENGTH;
module.exports.DEFAULT_NOTICES = DEFAULT_NOTICES;
module.exports.NOTICE_FIELDS = NOTICE_FIELDS;
