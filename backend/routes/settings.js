const express = require('express');
const { settings: settingsRepo } = require('../data');
const mailer = require('../services/mailer');
const { DEFAULT_STORE_TITLE, DEFAULT_NOTICES, NOTICE_FIELDS, DEFAULT_CONTACT, CONTACT_FIELDS } = require('../constants/settings');
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
		const [settings, otpAvailable] = await Promise.all([settingsRepo.findStorefront(), mailer.isMailAvailable().catch((error) => {
			// Settings still render when the mail row is unreadable; sign-in by code is simply off.
			console.error('Error reading mail availability:', error);
			return false;
		})]);

		res.json({
			success: true,
			data: {
				// findStorefront returns stored values only; a row saved before
				// storeTitle existed has none.
				storeTitle: settings?.storeTitle || DEFAULT_STORE_TITLE,
				// `??` rather than `||`: an admin-saved empty string means "hide it".
				...Object.fromEntries(TEXT_FIELDS.map((field) => [
					field,
					settings?.[field] ?? TEXT_DEFAULTS[field]
				])),
				// Public by design (the One Tap button needs it); not a secret.
				googleClientId: settings?.googleClientId || null,
				// Whether the sign-in-by-code form can work; the SMTP details stay private.
				otpAvailable: otpAvailable === true
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
