import React, { useState, useEffect } from 'react';
import { toast } from 'react-toastify';
import api, { settingsService, DEFAULT_STORE_TITLE, STORE_TITLE_MAX_LENGTH } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';

const SettingsManagement = () => {
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [settings, setSettings] = useState({
		bankNameId: '',
		bankAccountId: '',
		prefixMessage: 'SAB',
		storeTitle: DEFAULT_STORE_TITLE
	});
	const [originalSettings, setOriginalSettings] = useState(null);

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
				console.log('No settings found, using defaults');
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
	};

	const handleSubmit = async (e) => {
		e.preventDefault();

		if (!settings.bankNameId.trim()) {
			toast.error('Vui lòng nhập Bank ID');
			return;
		}

		if (!settings.bankAccountId.trim()) {
			toast.error('Vui lòng nhập số tài khoản');
			return;
		}

		if (!settings.prefixMessage.trim()) {
			toast.error('Vui lòng nhập prefix message');
			return;
		}

		if (!settings.storeTitle.trim()) {
			toast.error('Vui lòng nhập tiêu đề cửa hàng');
			return;
		}

		setSaving(true);
		try {
			const response = await api.put('/admin/settings', {
				bankNameId: settings.bankNameId.trim(),
				bankAccountId: settings.bankAccountId.trim(),
				prefixMessage: settings.prefixMessage.trim(),
				storeTitle: settings.storeTitle.trim()
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
		}
	};

	const hasChanges = () => {
		if (!originalSettings) return true;
		return (
			settings.bankNameId !== originalSettings.bankNameId ||
			settings.bankAccountId !== originalSettings.bankAccountId ||
			settings.prefixMessage !== originalSettings.prefixMessage ||
			settings.storeTitle !== originalSettings.storeTitle
		);
	};

	if (loading) {
		return <LoadingSpinner />;
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="max-w-3xl mx-auto">
				<div className="bg-white rounded-lg shadow-md p-6">
					<h1 className="text-2xl font-bold mb-6">Cấu hình cửa hàng</h1>

					<form onSubmit={handleSubmit} className="space-y-6">
						<div>
							<label htmlFor="storeTitle" className="block text-sm font-medium text-gray-700 mb-2">
								Tiêu đề cửa hàng <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="storeTitle"
								name="storeTitle"
								value={settings.storeTitle}
								onChange={handleChange}
								placeholder={`VD: ${DEFAULT_STORE_TITLE}`}
								maxLength={STORE_TITLE_MAX_LENGTH}
								className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
								required
							/>
							<p className="mt-1 text-sm text-gray-500">
								Hiển thị trên thanh tiêu đề của trang bán hàng
							</p>
						</div>

						<h2 className="text-lg font-semibold text-gray-800 pt-2">Thanh toán VietQR</h2>

						<div>
							<label htmlFor="bankNameId" className="block text-sm font-medium text-gray-700 mb-2">
								Bank ID <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="bankNameId"
								name="bankNameId"
								value={settings.bankNameId}
								onChange={handleChange}
								placeholder="VD: MB, VCB, TCB"
								className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
								required
							/>
							<p className="mt-1 text-sm text-gray-500">
								Mã ngân hàng theo chuẩn VietQR (MB, VCB, TCB, ACB, v.v.)
							</p>
						</div>

						<div>
							<label htmlFor="bankAccountId" className="block text-sm font-medium text-gray-700 mb-2">
								Số tài khoản <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="bankAccountId"
								name="bankAccountId"
								value={settings.bankAccountId}
								onChange={handleChange}
								placeholder="Nhập số tài khoản ngân hàng"
								className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
								required
							/>
							<p className="mt-1 text-sm text-gray-500">
								Số tài khoản nhận thanh toán
							</p>
						</div>

						<div>
							<label htmlFor="prefixMessage" className="block text-sm font-medium text-gray-700 mb-2">
								Prefix Message <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="prefixMessage"
								name="prefixMessage"
								value={settings.prefixMessage}
								onChange={handleChange}
								placeholder="VD: SAB"
								className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
								required
							/>
							<p className="mt-1 text-sm text-gray-500">
								Tiền tố cho nội dung chuyển khoản (thường là tên tổ chức)
							</p>
						</div>

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
