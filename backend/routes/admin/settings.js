const express = require('express');
const { gated } = require('../../services/write-gate');
const { contactEmail, contactUrl } = require('@sab/shared');
const { settings: settingsRepo } = require('../../data');
const { RecordValidationError } = require('../../data/errors');
const { authenticateAdmin } = require('../../middleware/better-auth');
const { validateMailSettings, validateMailTest } = require('../../middleware/validation');
const { MailServiceError, getPublicConfig, saveConfig, sendTest, takeTestSlot } = require('../../services/mailer');
const ErrorLogger = require('../../utils/errorLogger');

const { STORE_TITLE_MAX_LENGTH, NOTICE_MAX_LENGTH, NOTICE_FIELDS, CONTACT_FIELDS } = require('../../constants/settings');
const CONTACT_SCHEMAS = { contactEmail, contactFacebookUrl: contactUrl };
const router = express.Router();

const toResponse = (settings) => ({
	bankNameId: settings.bankNameId,
	bankAccountId: settings.bankAccountId,
	prefixMessage: settings.prefixMessage,
	storeTitle: settings.storeTitle,
	...Object.fromEntries([...NOTICE_FIELDS, ...CONTACT_FIELDS].map((field) => [field, settings[field]])),
	updatedAt: settings.updatedAt,
	updatedBy: settings.updatedBy
});

router.use(authenticateAdmin);

/**
 * @route   GET /api/admin/settings
 * @desc    Get store and payment settings
 * @access  Private (Admin only)
 */
router.get('/', async (req, res) => {
	try {
		const settings = await settingsRepo.findConfig();

		if (!settings) {
			return res.status(404).json({
				success: false,
				message: 'Chưa có cấu hình cửa hàng'
			});
		}

		res.json({
			success: true,
			data: toResponse(settings)
		});

	} catch (error) {
		console.error('Error fetching settings:', error);
		res.status(500).json({
			success: false,
			message: 'Lỗi server khi lấy cấu hình'
		});
	}
});

/**
 * @route   PUT /api/admin/settings
 * @desc    Update store and payment settings
 * @access  Private (Admin only)
 */
router.put('/', gated(async (req, res) => {
	try {
		const { bankNameId, bankAccountId, prefixMessage, storeTitle } = req.body;

		if (!bankNameId || !bankAccountId || !prefixMessage) {
			return res.status(400).json({
				success: false,
				message: 'Vui lòng cung cấp đầy đủ thông tin: bankNameId, bankAccountId, prefixMessage'
			});
		}

		const updateData = {
			bankNameId: bankNameId.trim(),
			bankAccountId: bankAccountId.trim(),
			prefixMessage: prefixMessage.trim(),
			updatedBy: req.admin?.username || 'admin'
		};

		// Optional: omitting it keeps the stored title. A non-string is rejected
		// here rather than cast, so an operator object can never reach the update.
		if (storeTitle !== undefined) {
			const title = typeof storeTitle === 'string' ? storeTitle.trim() : '';
			if (!title || title.length > STORE_TITLE_MAX_LENGTH) {
				return res.status(400).json({
					success: false,
					message: `Tiêu đề cửa hàng phải từ 1 đến ${STORE_TITLE_MAX_LENGTH} ký tự`
				});
			}
			updateData.storeTitle = title;
		}

		// Each notice is optional like the title; an empty string is kept so the
		// admin can hide that reminder.
		for (const field of NOTICE_FIELDS) {
			const value = req.body[field];
			if (value === undefined) continue;
			if (typeof value !== 'string' || value.length > NOTICE_MAX_LENGTH) {
				return res.status(400).json({
					success: false,
					message: `Lời nhắc phải là văn bản tối đa ${NOTICE_MAX_LENGTH} ký tự`
				});
			}
			updateData[field] = value.trim();
		}

		// Optional too; an empty string hides that footer line.
		for (const field of CONTACT_FIELDS) {
			if (req.body[field] === undefined) continue;
			const parsed = CONTACT_SCHEMAS[field].safeParse(req.body[field]);
			if (!parsed.success) {
				return res.status(400).json({
					success: false,
					message: parsed.error.issues[0].message
				});
			}
			updateData[field] = parsed.data;
		}

		const settings = await settingsRepo.upsertConfig(updateData);

		res.json({
			success: true,
			message: 'Cập nhật cấu hình thành công',
			data: toResponse(settings)
		});

	} catch (error) {
		console.error('Error updating settings:', error);

		if (error instanceof RecordValidationError) {
			return res.status(400).json({
				success: false,
				message: 'Dữ liệu không hợp lệ',
				errors: error.fieldErrors.map(entry => entry.message)
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi cập nhật cấu hình'
		});
	}
}));

/** Answers a mailer failure: its own message when it is meant for the admin, a generic 500 otherwise. */
function mailFailure(res, error, route, fallbackMessage) {
	if (error instanceof MailServiceError) {
		return res.status(error.status).json({ success: false, message: error.message });
	}
	ErrorLogger.log(error, { route });
	return res.status(500).json({ success: false, message: fallbackMessage });
}

const adminName = (req) => req.admin?.username || req.admin?.email || 'admin';

/**
 * @route   GET /api/admin/settings/mail
 * @desc    SMTP settings for order mail; the password is never returned (`hasPassword` instead)
 * @access  Private (Admin only)
 */
router.get('/mail', async (req, res) => {
	try {
		res.json({ success: true, data: await getPublicConfig() });
	} catch (error) {
		mailFailure(res, error, 'GET /admin/settings/mail', 'Lỗi server khi lấy cấu hình mail');
	}
});

/**
 * @route   PUT /api/admin/settings/mail
 * @desc    Save SMTP settings; omitting `pass` keeps the stored password
 * @access  Private (Admin only)
 */
router.put('/mail', validateMailSettings, gated(async (req, res) => {
	try {
		const data = await saveConfig(req.body, adminName(req));
		res.json({ success: true, message: 'Cập nhật cấu hình mail thành công', data });
	} catch (error) {
		mailFailure(res, error, 'PUT /admin/settings/mail', 'Lỗi server khi cập nhật cấu hình mail');
	}
}));

/**
 * @route   POST /api/admin/settings/mail/test
 * @desc    Send one test mail through the saved SMTP account (5 per 10 minutes per admin)
 * @access  Private (Admin only)
 */
router.post('/mail/test', validateMailTest, async (req, res) => {
	if (!takeTestSlot(String(req.admin?.id || adminName(req)))) {
		return res.status(429).json({ success: false, message: 'Gửi thử quá nhiều lần, vui lòng thử lại sau ít phút' });
	}
	try {
		await sendTest(req.body.to.trim());
		res.json({ success: true, message: 'Đã gửi mail thử' });
	} catch (error) {
		mailFailure(res, error, 'POST /admin/settings/mail/test', 'Lỗi server khi gửi mail thử');
	}
});

module.exports = router;
