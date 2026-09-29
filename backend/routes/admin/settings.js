const express = require('express');
const Settings = require('../../models/Settings');

const { SETTINGS_KEY, STORE_TITLE_MAX_LENGTH } = Settings;
const { authenticateAdmin } = require('../../middleware/better-auth');
const router = express.Router();

const toResponse = (settings) => ({
	bankNameId: settings.bankNameId,
	bankAccountId: settings.bankAccountId,
	prefixMessage: settings.prefixMessage,
	storeTitle: settings.storeTitle,
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
		const settings = await Settings.findOne({ key: SETTINGS_KEY });

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
router.put('/', async (req, res) => {
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

		const settings = await Settings.findOneAndUpdate(
			{ key: SETTINGS_KEY },
			updateData,
			{
				new: true,
				upsert: true,
				runValidators: true
			}
		);

		res.json({
			success: true,
			message: 'Cập nhật cấu hình thành công',
			data: toResponse(settings)
		});

	} catch (error) {
		console.error('Error updating settings:', error);

		if (error.name === 'ValidationError') {
			return res.status(400).json({
				success: false,
				message: 'Dữ liệu không hợp lệ',
				errors: Object.values(error.errors).map(err => err.message)
			});
		}

		res.status(500).json({
			success: false,
			message: 'Lỗi server khi cập nhật cấu hình'
		});
	}
});

module.exports = router;
