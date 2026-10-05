import React, { useState, useEffect } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { adminService } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import ShareButton from '../../components/ShareButton';
import { SALES_CHANNELS, SALES_CHANNEL_LABELS, normalizeSalesChannel } from '../../utils/sales-channel';
import { comboPath } from '../../utils/share-links';

const ComboManagement = () => {
	const [combos, setCombos] = useState([]);
	const [categories, setCategories] = useState([]);
	const [loading, setLoading] = useState(true);
	const [showModal, setShowModal] = useState(false);
	const [editingCombo, setEditingCombo] = useState(null);
	const [formData, setFormData] = useState({
		name: '',
		description: '',
		price: '',
		priority: 0,
		categoryRequirements: [{ category: '', quantity: 1 }],
		isActive: true,
		salesChannel: 'all'
	});
	const [submitting, setSubmitting] = useState(false);

	// Fetch combos and categories
	useEffect(() => {
		fetchCombos();
		fetchCategories();
	}, []);

	const fetchCombos = async () => {
		try {
			console.log('[COMBO] Fetching combos...');
			setLoading(true);
			const response = await adminService.getCombos();
			console.log('[COMBO] Combos response:', response);
			if (response.success) {
				setCombos(response.data.combos);
			}
		} catch (error) {
			console.error('[COMBO] Error fetching combos:', error);
			toast.error('Lỗi khi tải danh sách combo');
		} finally {
			setLoading(false);
		}
	};

	const fetchCategories = async () => {
		try {
			console.log('[COMBO] Fetching categories...');
			const response = await adminService.getProductCategories();
			console.log('[COMBO] Categories response:', response);
			if (response.success) {
				setCategories(response.data.categories);
			}
		} catch (error) {
			console.error('[COMBO] Error fetching categories:', error);
		}
	};

	const formatCurrency = (amount) => {
		return new Intl.NumberFormat('vi-VN', {
			style: 'currency',
			currency: 'VND'
		}).format(amount);
	};

	const handleSubmit = async (e) => {
		e.preventDefault();

		console.log('[COMBO] Form submitted with data:', formData);

		// Validate form
		if (!formData.name || !formData.price || formData.categoryRequirements.length === 0) {
			toast.error('Vui lòng điền đầy đủ thông tin');
			return;
		}

		// Validate category requirements
		const hasEmptyRequirement = formData.categoryRequirements.some(req =>
			!req.category || req.quantity < 1
		);

		if (hasEmptyRequirement) {
			toast.error('Vui lòng điền đầy đủ yêu cầu danh mục');
			return;
		}

		if (submitting) return;
		setSubmitting(true);
		try {
			const comboData = {
				...formData,
				price: parseFloat(formData.price),
				priority: parseInt(formData.priority) || 0,
				categoryRequirements: formData.categoryRequirements.map(req => ({
					category: req.category,
					quantity: parseInt(req.quantity)
				}))
			};

			console.log('[COMBO] Sending combo data:', comboData);

			let response;
			if (editingCombo) {
				response = await adminService.updateCombo(editingCombo._id, comboData);
			} else {
				response = await adminService.createCombo(comboData);
			}

			console.log('[COMBO] Response:', response);

			if (response.success) {
				toast.success(editingCombo ? 'Cập nhật combo thành công' : 'Tạo combo thành công');
				setShowModal(false);
				resetForm();
				fetchCombos();
			}
		} catch (error) {
			console.error('[COMBO] Error:', error);
			toast.error(error.message || 'Có lỗi xảy ra');
		} finally {
			setSubmitting(false);
		}
	};

	const handleEdit = (combo) => {
		setEditingCombo(combo);
		setFormData({
			name: combo.name,
			description: combo.description || '',
			price: combo.price.toString(),
			priority: combo.priority || 0,
			categoryRequirements: combo.categoryRequirements.map(req => ({
				category: req.category,
				quantity: req.quantity
			})),
			isActive: combo.isActive,
			salesChannel: normalizeSalesChannel(combo.salesChannel)
		});
		setShowModal(true);
	};

	const handleDelete = async (combo) => {
		const result = await Swal.fire({
			title: 'Xác nhận xóa',
			text: `Bạn có chắc chắn muốn xóa combo "${combo.name}"?`,
			icon: 'warning',
			showCancelButton: true,
			confirmButtonText: 'Xóa',
			cancelButtonText: 'Hủy',
			confirmButtonColor: '#d33'
		});

		if (result.isConfirmed) {
			try {
				const response = await adminService.deleteCombo(combo._id);
				if (response.success) {
					toast.success('Xóa combo thành công');
					fetchCombos();
				}
			} catch (error) {
				toast.error(error.message || 'Có lỗi xảy ra khi xóa combo');
			}
		}
	};

	const handleToggleActive = async (combo) => {
		try {
			const response = await adminService.updateCombo(combo._id, {
				isActive: !combo.isActive
			});

			if (response.success) {
				toast.success(`${combo.isActive ? 'Tắt' : 'Bật'} combo thành công`);
				fetchCombos();
			}
		} catch (error) {
			toast.error(error.message || 'Có lỗi xảy ra');
		}
	};

	const resetForm = () => {
		setEditingCombo(null);
		setFormData({
			name: '',
			description: '',
			price: '',
			priority: 0,
			categoryRequirements: [{ category: '', quantity: 1 }],
			isActive: true,
			salesChannel: 'all'
		});
	};

	const addCategoryRequirement = () => {
		setFormData(prev => ({
			...prev,
			categoryRequirements: [...prev.categoryRequirements, { category: '', quantity: 1 }]
		}));
	};

	const removeCategoryRequirement = (index) => {
		setFormData(prev => ({
			...prev,
			categoryRequirements: prev.categoryRequirements.filter((_, i) => i !== index)
		}));
	};

	const updateCategoryRequirement = (index, field, value) => {
		setFormData(prev => ({
			...prev,
			categoryRequirements: prev.categoryRequirements.map((req, i) =>
				i === index ? { ...req, [field]: value } : req
			)
		}));
	};

	if (loading) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<LoadingSpinner size="large" text="Đang tải danh sách combo..." />
			</div>
		);
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="max-w-6xl mx-auto">
				{/* Header */}
				<div className="flex justify-between items-center mb-8">
					<div>
						<h1 className="text-3xl font-bold text-gray-900 mb-2">
							<i className="fas fa-boxes mr-3 text-blue-700"></i>
							Quản lý Combo
						</h1>
						<p className="text-gray-600">
							Tạo và quản lý các combo sản phẩm với giá ưu đãi
						</p>
					</div>
					<button
						onClick={() => {
							resetForm();
							setShowModal(true);
						}}
						className="btn-primary"
					>
						<i className="fas fa-plus mr-2"></i>
						Tạo combo mới
					</button>
				</div>

				{/* Combos List */}
				<div className="card">
					<div className="p-6">
						<h2 className="text-xl font-semibold text-gray-900 mb-4">
							Danh sách combo ({combos.length})
						</h2>

						{combos.length === 0 ? (
							<div className="text-center py-12">
								<i className="fas fa-box-open text-6xl text-gray-300 mb-4"></i>
								<h3 className="text-xl font-semibold text-gray-900 mb-2">
									Chưa có combo nào
								</h3>
								<p className="text-gray-600 mb-4">
									Tạo combo đầu tiên để bắt đầu
								</p>
								<button
									onClick={() => {
										resetForm();
										setShowModal(true);
									}}
									className="btn-primary"
								>
									<i className="fas fa-plus mr-2"></i>
									Tạo combo mới
								</button>
							</div>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full table-auto">
									<thead>
										<tr className="border-b border-gray-200">
											<th className="hidden md:table-cell text-left py-3 px-4 font-semibold text-gray-900">
												Mã
											</th>
											<th className="text-left py-3 px-4 font-semibold text-gray-900">
												Tên combo
											</th>
											<th className="text-left py-3 px-4 font-semibold text-gray-900">
												Giá
											</th>
											<th className="text-left py-3 px-4 font-semibold text-gray-900">
												Yêu cầu
											</th>
											<th className="text-left py-3 px-4 font-semibold text-gray-900">
												Ưu tiên
											</th>
											<th className="text-left py-3 px-4 font-semibold text-gray-900">
												Kênh áp dụng
											</th>
											<th className="text-left py-3 px-4 font-semibold text-gray-900">
												Trạng thái
											</th>
											<th className="text-left py-3 px-4 font-semibold text-gray-900">
												Thao tác
											</th>
										</tr>
									</thead>
									<tbody>
										{combos.map(combo => (
											<tr key={combo._id} className="border-b border-gray-100 hover:bg-gray-50">
												<td className="hidden md:table-cell py-3 px-4 font-mono text-sm text-gray-700">
													{combo.publicCode || '—'}
												</td>
												<td className="py-3 px-4">
													<div>
														<div className="font-medium text-gray-900">
															{combo.name}
														</div>
														{combo.description && (
															<div className="text-sm text-gray-600">
																{combo.description}
															</div>
														)}
													</div>
												</td>
												<td className="py-3 px-4">
													<span className="font-semibold text-blue-700">
														{formatCurrency(combo.price)}
													</span>
												</td>
												<td className="py-3 px-4">
													<div className="text-sm">
														{combo.categoryRequirements.map((req, index) => (
															<div key={index} className="mb-1">
																<span className="inline-block bg-gray-100 text-gray-800 px-2 py-1 rounded text-xs">
																	{req.quantity}x {req.category}
																</span>
															</div>
														))}
													</div>
												</td>
												<td className="py-3 px-4">
													<span className="text-gray-600">
														{combo.priority}
													</span>
												</td>
												<td className="py-3 px-4">
													<span className="inline-block bg-blue-50 text-blue-800 px-2 py-1 rounded text-xs whitespace-nowrap">
														{SALES_CHANNEL_LABELS[normalizeSalesChannel(combo.salesChannel)]}
													</span>
												</td>
												<td className="py-3 px-4">
													<button
														onClick={() => handleToggleActive(combo)}
														className={`px-3 py-1 rounded-full text-xs font-medium ${combo.isActive
															? 'bg-green-100 text-green-800 hover:bg-green-200'
															: 'bg-red-100 text-red-800 hover:bg-red-200'
															}`}
													>
														{combo.isActive ? 'Hoạt động' : 'Tắt'}
													</button>
												</td>
												<td className="py-3 px-4">
													<div className="flex items-center space-x-2">
														<ShareButton
															mode="copy"
															path={comboPath(combo)}
															disabledHint="Chưa có mã — chạy backfill"
															className="px-3 py-1 text-xs whitespace-nowrap"
														/>
														<button
															onClick={() => handleEdit(combo)}
															className="text-blue-600 hover:text-blue-800"
															title="Chỉnh sửa"
														>
															<i className="fas fa-edit"></i>
														</button>
														<button
															onClick={() => handleDelete(combo)}
															className="text-red-600 hover:text-red-800"
															title="Xóa"
														>
															<i className="fas fa-trash"></i>
														</button>
													</div>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
				</div>

				{/* Modal for Create/Edit Combo */}
				<Modal 
					isOpen={showModal}
					onClose={() => setShowModal(false)} 
					title={editingCombo ? 'Chỉnh sửa combo' : 'Tạo combo mới'}
				>
					<form onSubmit={handleSubmit} className="space-y-4">
							{/* Basic Information */}
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
								<div>
									<label className="block text-sm font-medium text-gray-700 mb-2">
										Tên combo *
									</label>
									<input
										type="text"
										value={formData.name}
										onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
										placeholder="Nhập tên combo"
										required
									/>
								</div>

								<div>
									<label className="block text-sm font-medium text-gray-700 mb-2">
										Giá combo *
									</label>
									<input
										type="number"
										value={formData.price}
										onChange={(e) => setFormData(prev => ({ ...prev, price: e.target.value }))}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
										placeholder="0"
										min="0"
										step="1000"
										required
									/>
								</div>
							</div>

							<div>
								<label className="block text-sm font-medium text-gray-700 mb-2">
									Mô tả
								</label>
								<textarea
									value={formData.description}
									onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
									className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
									rows="3"
									placeholder="Mô tả combo (tùy chọn)"
								/>
							</div>

							<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
								<div>
									<label className="block text-sm font-medium text-gray-700 mb-2">
										Độ ưu tiên
									</label>
									<input
										type="number"
										value={formData.priority}
										onChange={(e) => setFormData(prev => ({ ...prev, priority: parseInt(e.target.value) || 0 }))}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
										placeholder="0"
										min="0"
									/>
									<p className="text-xs text-gray-500 mt-1">
										Số cao hơn được ưu tiên áp dụng trước
									</p>
								</div>

								<div>
									<label className="flex items-center mt-8">
										<input
											type="checkbox"
											checked={formData.isActive}
											onChange={(e) => setFormData(prev => ({ ...prev, isActive: e.target.checked }))}
											className="mr-2"
										/>
										<span className="text-sm font-medium text-gray-700">
											Combo hoạt động
										</span>
									</label>
								</div>
							</div>

							<div>
								<label className="block text-sm font-medium text-gray-700 mb-2">
									Kênh áp dụng
								</label>
								<select
									value={formData.salesChannel}
									onChange={(e) => setFormData(prev => ({ ...prev, salesChannel: e.target.value }))}
									className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
								>
									{SALES_CHANNELS.map(channel => (
										<option key={channel} value={channel}>
											{SALES_CHANNEL_LABELS[channel]}
										</option>
									))}
								</select>
							</div>

							{/* Category Requirements */}
							<div>
								<div className="flex justify-between items-center mb-3">
									<label className="block text-sm font-medium text-gray-700">
										Yêu cầu danh mục *
									</label>
									<button
										type="button"
										onClick={addCategoryRequirement}
										className="text-blue-600 hover:text-blue-800 text-sm"
									>
										<i className="fas fa-plus mr-1"></i>
										Thêm danh mục
									</button>
								</div>

								{formData.categoryRequirements.map((requirement, index) => (
									<div key={index} className="flex gap-3 items-center mb-3">
										<select
											value={requirement.category}
											onChange={(e) => updateCategoryRequirement(index, 'category', e.target.value)}
											className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
											required
										>
											<option value="">Chọn danh mục</option>
											{categories.map(category => (
												<option key={category} value={category}>
													{category}
												</option>
											))}
										</select>

										<input
											type="number"
											value={requirement.quantity}
											onChange={(e) => updateCategoryRequirement(index, 'quantity', parseInt(e.target.value) || 1)}
											className="w-20 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-center"
											min="1"
											required
										/>

										{formData.categoryRequirements.length > 1 && (
											<button
												type="button"
												onClick={() => removeCategoryRequirement(index)}
												className="text-red-600 hover:text-red-800 p-2"
											>
												<i className="fas fa-trash"></i>
											</button>
										)}
									</div>
								))}
							</div>

							{/* Actions */}
							<div className="flex justify-end space-x-3 pt-4">
								<button
									type="button"
									onClick={() => setShowModal(false)}
									className="btn-secondary"
								>
									Hủy
								</button>
								<button type="submit" className="btn-primary" disabled={submitting}>
									{submitting ? 'Đang lưu...' : editingCombo ? 'Cập nhật' : 'Tạo combo'}
								</button>
							</div>
						</form>
					</Modal>
			</div>
		</div>
	);
};

export default ComboManagement;
