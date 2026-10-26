const mongoose = require('mongoose');

const {
	SETTINGS_KEY,
	DEFAULT_STORE_TITLE,
	STORE_TITLE_MAX_LENGTH,
	NOTICE_MAX_LENGTH,
	DEFAULT_NOTICES,
	DEFAULT_CONTACT,
	DEFAULT_PREFIX_MESSAGE,
	DEFAULT_UPDATED_BY
} = require('../constants/settings');

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
		default: DEFAULT_PREFIX_MESSAGE,
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
	contactEmail: {
		type: String,
		trim: true,
		default: DEFAULT_CONTACT.contactEmail,
		description: 'Contact email shown in the public footer'
	},
	contactFacebookUrl: {
		type: String,
		trim: true,
		default: DEFAULT_CONTACT.contactFacebookUrl,
		description: 'Facebook page link shown in the public footer'
	},
	googleClientId: {
		type: String,
		trim: true,
		default: '',
		description: 'Google One Tap Web client id; empty turns Google sign-in off'
	},
	updatedAt: {
		type: Date,
		default: Date.now
	},
	updatedBy: {
		type: String,
		default: DEFAULT_UPDATED_BY
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
// init-database.js still reads the key from the model.
