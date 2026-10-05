import React, { useState, useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import api, { settingsService, DEFAULT_STORE_TITLE, STORE_TITLE_MAX_LENGTH, NOTICE_MAX_LENGTH } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import MarkdownEditor from '../../components/admin/MarkdownEditor';
import useFieldErrors from '../../hooks/use-field-errors';
import FormField from '../../components/form/FormField';

// Client rules mirror PUT /api/admin/settings (the server stays authoritative).
const SETTINGS_RULES = {
	storeTitle: (value) => {
		const v = value.trim();
		if (!v) return 'Tiêu đề cửa hàng là bắt buộc';
		return v.length > STORE_TITLE_MAX_LENGTH ? `Tiêu đề cửa hàng phải từ 1 đến ${STORE_TITLE_MAX_LENGTH} ký tự` : null;
	},
	bankNameId: (value) => (value.trim() ? null : 'Bank ID là bắt buộc'),
	bankAccountId: (value) => (value.trim() ? null : 'Số tài khoản là bắt buộc'),
	prefixMessage: (value) => (value.trim() ? null : 'Prefix message là bắt buộc')
};

// Where each customer reminder appears; the preview reuses that box's text colour.
const NOTICES = [
	{ field: 'checkoutNotice', label: 'Lưu ý ở trang thanh toán (giỏ hàng)', previewClassName: 'text-warning-700' },
	{ field: 'eventNotice', label: 'Lưu ý ở trang đặt hàng sự kiện', previewClassName: 'text-warning-700' },
	{ field: 'paymentNotice', label: 'Lời nhắc phía trên mã QR thanh toán', previewClassName: 'text-red-600' }
];
const NOTICE_FIELDS = NOTICES.map(({ field }) => field);

const SettingsManagement = () => {
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [settings, setSettings] = useState({
		bankNameId: '',
		bankAccountId: '',
		prefixMessage: 'SAB',
		storeTitle: DEFAULT_STORE_TITLE,
		checkoutNotice: '',
		eventNotice: '',
		paymentNotice: ''
	});
	const [originalSettings, setOriginalSettings] = useState(null);
	const { errors, validateField, onFieldChange, validateAll, focusFirstError, reset: resetFieldErrors } = useFieldErrors(SETTINGS_RULES);
	const formRef = useRef(null);

	useEffect(() => {
		fetchSettings();
	}, []);

	const fetchSettings = async () => {
		setLoading(true);
		try {
			const response = await api.get('/admin/settings');
			if (response.data.success) {
				setSettings(response.data.data);
				setOriginalSettings(response.data.data);
			}
		} catch (error) {
			if (error.response?.status === 404) {
				// No document yet: start the notices from the server's defaults, which
				// is what customers currently see, instead of blank (= hidden).
				const publicSettings = await settingsService.getPublicSettings().catch(() => null);
				if (!publicSettings) {
					toast.warn('Không tải được lời nhắc mặc định; lưu lúc này sẽ ẩn các lời nhắc đang để trống');
				} else {
					setSettings(prev => ({
						...prev,
						...Object.fromEntries(NOTICE_FIELDS.map(field => [field, publicSettings[field] ?? '']))
					}));
				}
			} else {
				toast.error(error.response?.data?.message || 'Lỗi khi tải cấu hình');
			}
		} finally {
			setLoading(false);
		}
	};

	const handleChange = (e) => {
		const { name, value } = e.target;
		setSettings(prev => ({
			...prev,
			[name]: value
		}));
		onFieldChange(name, value, { ...settings, [name]: value });
	};

	const handleBlur = (e) => {
		validateField(e.target.name, e.target.value, settings);
	};

	const handleNoticeChange = (field) => (value) => {
		setSettings(prev => ({ ...prev, [field]: value }));
	};

	const handleSubmit = async (e) => {
		e.preventDefault();

		if (!validateAll(settings)) {
			focusFirstError(formRef);
			return;
		}

		if (NOTICE_FIELDS.some(field => settings[field].length > NOTICE_MAX_LENGTH)) {
			toast.error(`Mỗi lời nhắc tối đa ${NOTICE_MAX_LENGTH} ký tự`);
			return;
		}

		setSaving(true);
		try {
			const response = await api.put('/admin/settings', {
				bankNameId: settings.bankNameId.trim(),
				bankAccountId: settings.bankAccountId.trim(),
				prefixMessage: settings.prefixMessage.trim(),
				storeTitle: settings.storeTitle.trim(),
				...Object.fromEntries(NOTICE_FIELDS.map(field => [field, settings[field]]))
			});

			if (response.data.success) {
				toast.success('Cập nhật cấu hình thành công');
				setSettings(response.data.data);
				setOriginalSettings(response.data.data);
				settingsService.clearPublicSettingsCache();
			}
		} catch (error) {
			toast.error(error.response?.data?.message || 'Lỗi khi cập nhật cấu hình');
		} finally {
			setSaving(false);
		}
	};

	const handleReset = () => {
		if (originalSettings) {
			setSettings(originalSettings);
			resetFieldErrors();
		}
	};

	const hasChanges = () => {
		if (!originalSettings) return true;
		return (
			settings.bankNameId !== originalSettings.bankNameId ||
			settings.bankAccountId !== originalSettings.bankAccountId ||
			settings.prefixMessage !== originalSettings.prefixMessage ||
			settings.storeTitle !== originalSettings.storeTitle ||
			NOTICE_FIELDS.some(field => settings[field] !== originalSettings[field])
		);
	};

	if (loading) {
		return <LoadingSpinner />;
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="max-w-5xl mx-auto">
				<div className="bg-white rounded-lg shadow-md p-6">
					<h1 className="text-2xl font-bold mb-6">Cấu hình cửa hàng</h1>

					<form ref={formRef} onSubmit={handleSubmit} noValidate className="space-y-6">
						<FormField
							id="settings-storeTitle"
							label="Tiêu đề cửa hàng" required
							error={errors.storeTitle}
							hint="Hiển thị trên thanh tiêu đề của trang bán hàng"
						>
							<input
								type="text"
								name="storeTitle"
								value={settings.storeTitle}
								onChange={handleChange}
								onBlur={handleBlur}
								placeholder={`VD: ${DEFAULT_STORE_TITLE}`}
								maxLength={STORE_TITLE_MAX_LENGTH}
								className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
							/>
						</FormField>

						<h2 className="text-lg font-semibold text-gray-800 pt-2">Thanh toán VietQR</h2>

						<FormField
							id="settings-bankNameId"
							label="Bank ID" required
							error={errors.bankNameId}
							hint="Mã ngân hàng theo chuẩn VietQR (MB, VCB, TCB, ACB, v.v.)"
						>
							<input
								type="text"
								name="bankNameId"
								value={settings.bankNameId}
								onChange={handleChange}
								onBlur={handleBlur}
								placeholder="VD: MB, VCB, TCB"
								className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
							/>
						</FormField>

						<FormField
							id="settings-bankAccountId"
							label="Số tài khoản" required
							error={errors.bankAccountId}
							hint="Số tài khoản nhận thanh toán"
						>
							<input
								type="text"
								name="bankAccountId"
								value={settings.bankAccountId}
								onChange={handleChange}
								onBlur={handleBlur}
								placeholder="Nhập số tài khoản ngân hàng"
								className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
							/>
						</FormField>

						<FormField
							id="settings-prefixMessage"
							label="Prefix Message" required
							error={errors.prefixMessage}
							hint="Tiền tố cho nội dung chuyển khoản (thường là tên tổ chức)"
						>
							<input
								type="text"
								name="prefixMessage"
								value={settings.prefixMessage}
								onChange={handleChange}
								onBlur={handleBlur}
								placeholder="VD: SAB"
								className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
							/>
						</FormField>

						<h2 className="text-lg font-semibold text-gray-800 pt-2">Lời nhắc cho khách hàng</h2>
						<p className="text-sm text-gray-500 -mt-4">
							Soạn bằng Markdown (<code>- </code> cho danh sách, <code>**đậm**</code>, <code>[liên kết](https://...)</code>). Để trống để ẩn lời nhắc.
						</p>

						{NOTICES.map(({ field, label, previewClassName }) => (
							<div key={field}>
								<p className="block text-sm font-medium text-gray-700 mb-2">{label}</p>
								<MarkdownEditor
									ariaLabel={label}
									value={settings[field]}
									onChange={handleNoticeChange(field)}
									maxLength={NOTICE_MAX_LENGTH}
									previewClassName={previewClassName}
								/>
							</div>
						))}

						{originalSettings && (
							<div className="bg-gray-50 p-4 rounded-md">
								<h3 className="font-medium text-sm text-gray-700 mb-2">Thông tin cập nhật</h3>
								<p className="text-sm text-gray-600">
									Cập nhật lần cuối: {new Date(originalSettings.updatedAt).toLocaleString('vi-VN')}
								</p>
								{originalSettings.updatedBy && (
									<p className="text-sm text-gray-600">
										Người cập nhật: {originalSettings.updatedBy}
									</p>
								)}
							</div>
						)}

						<div className="flex gap-4">
							<button
								type="submit"
								disabled={saving || !hasChanges()}
								className="flex-1 bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
							>
								{saving ? 'Đang lưu...' : 'Lưu cấu hình'}
							</button>

							{hasChanges() && (
								<button
									type="button"
									onClick={handleReset}
									disabled={saving}
									className="px-6 py-2 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
								>
									Hủy bỏ
								</button>
							)}
						</div>
					</form>

					<div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-md">
						<h3 className="font-medium text-blue-900 mb-2">Lưu ý</h3>
						<ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
							<li>Thông tin này được sử dụng để tạo mã QR thanh toán VietQR</li>
							<li>Thay đổi cấu hình sẽ ảnh hưởng đến tất cả đơn hàng mới</li>
							<li>Đảm bảo thông tin chính xác trước khi lưu</li>
							<li>Các đơn hàng đã tạo trước đó không bị ảnh hưởng</li>
						</ul>
					</div>
				</div>
			</div>
		</div>
	);
};

export default SettingsManagement;
