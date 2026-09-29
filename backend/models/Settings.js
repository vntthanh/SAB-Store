const mongoose = require('mongoose');

const SETTINGS_KEY = 'payment_config';
// frontend/src/services/api.js repeats both store-title constants for the
// header fallback and the admin form's input limit; keep them in sync.
const DEFAULT_STORE_TITLE = 'SAB Store';
const STORE_TITLE_MAX_LENGTH = 60;

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
