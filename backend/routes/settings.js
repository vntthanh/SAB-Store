const express = require('express');
const Settings = require('../models/Settings');

const { SETTINGS_KEY, DEFAULT_STORE_TITLE, DEFAULT_NOTICES, NOTICE_FIELDS, DEFAULT_CONTACT, CONTACT_FIELDS } = Settings;
// Free-text storefront fields: a missing one falls back to its default, an
// admin-saved empty string means "hide it".
const TEXT_DEFAULTS = { ...DEFAULT_NOTICES, ...DEFAULT_CONTACT };
const TEXT_FIELDS = [...NOTICE_FIELDS, ...CONTACT_FIELDS];
const router = express.Router();

/**
 * @route   GET /api/settings
 * @desc    Public storefront settings. Shares the payment settings document, so
 *          the projection is an allowlist: bank details never leave through here.
 * @access  Public
 */
router.get('/', async (req, res) => {
	try {
		const settings = await Settings.findOne({ key: SETTINGS_KEY }).select(['storeTitle', ...TEXT_FIELDS]).lean();

		res.json({
			success: true,
			data: {
				// A document saved before storeTitle existed has no such field, and
				// lean() skips schema defaults.
				storeTitle: settings?.storeTitle || DEFAULT_STORE_TITLE,
				// `??` rather than `||`: an admin-saved empty string means "hide it".
				...Object.fromEntries(TEXT_FIELDS.map((field) => [
					field,
					settings?.[field] ?? TEXT_DEFAULTS[field]
				]))
			}
		});
	} catch (error) {
		console.error('Error fetching public settings:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy cấu hình'
		});
	}
});

module.exports = router;
