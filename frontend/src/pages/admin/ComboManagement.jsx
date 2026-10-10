import React, { useState, useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { adminService } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import ShareButton from '../../components/ShareButton';
import { SALES_CHANNELS, SALES_CHANNEL_LABELS, normalizeSalesChannel } from '../../utils/sales-channel';
import { comboPath } from '../../utils/share-links';
import useFieldErrors from '../../hooks/use-field-errors';
import FormField from '../../components/form/FormField';

// Client rules mirror POST /api/combos and the Combo schema (the server stays authoritative).
const COMBO_RULES = {
	name: (value) => {
		const v = value.trim();
		if (!v) return 'Tên combo là bắt buộc';
		return v.length > 100 ? 'Tên combo không được vượt quá 100 ký tự' : null;
	},
	price: (value) => {
		if (String(value).trim() === '') return 'Giá combo là bắt buộc';
		const n = Number(value);
		// The server treats 0 as missing ("!price"), so 0 is rejected here too.
		if (!Number.isFinite(n) || n <= 0) return 'Giá combo phải lớn hơn 0';
		return Number.isInteger(n) ? null : 'Giá phải là số nguyên (VND)';
	},
	description: (value) => (value.length > 500 ? 'Mô tả không được vượt quá 500 ký tự' : null),
	categoryRequirements: (rows) => {
		if (rows.length === 0) return 'Combo phải có ít nhất một yêu cầu danh mục';
		return rows.some((row) => !row.category || !(row.quantity >= 1))
			? 'Mỗi yêu cầu cần chọn danh mục và số lượng từ 1 trở lên'
			: null;
	}
};

const INPUT_CLASS = 'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500';
const ROW_ERROR_CLASS = ' border-danger-500 ring-1 ring-danger-500 focus:border-danger-500 focus:ring-danger-500';

// Lives inside the Modal so every open starts with fresh values and no stale errors.
const ComboForm = ({ combo, categories, submitting, onSubmit, onCancel }) => {
	const [formData, setFormData] = useState(() => combo ? {
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
	} : {
		name: '',
		description: '',
		price: '',
		priority: 0,
		categoryRequirements: [{ category: '', quantity: 1 }],
		isActive: true,
		salesChannel: 'all'
	});
	const { errors, validateField, onFieldChange, validateAll, focusFirstError } = useFieldErrors(COMBO_RULES);
	const formRef = useRef(null);

	const setField = (name, value) => {
		setFormData(prev => ({ ...prev, [name]: value }));
		onFieldChange(name, value, { ...formData, [name]: value });
	};

	const handleBlur = (e) => {
		validateField(e.target.name, e.target.value, formData);
	};

	const setRequirements = (rows) => {
		setFormData(prev => ({ ...prev, categoryRequirements: rows }));
		onFieldChange('categoryRequirements', rows, { ...formData, categoryRequirements: rows });
	};

	const addCategoryRequirement = () => {
		setRequirements([...formData.categoryRequirements, { category: '', quantity: 1 }]);
	};

	const removeCategoryRequirement = (index) => {
		setRequirements(formData.categoryRequirements.filter((_, i) => i !== index));
	};

	const updateCategoryRequirement = (index, field, value) => {
		setRequirements(formData.categoryRequirements.map((req, i) =>
			i === index ? { ...req, [field]: value } : req
		));
	};

	// The rows share one message, so the offending inputs carry the red state and aria-invalid themselves.
	const rowInvalid = (requirement, field) => Boolean(errors.categoryRequirements) &&
		(field === 'category' ? !requirement.category : !(requirement.quantity >= 1));

	const handleSubmit = (e) => {
		e.preventDefault();
		if (submitting) return;
		if (!validateAll(formData)) {
			focusFirstError(formRef);
			return;
		}
		onSubmit({
			...formData,
			price: parseFloat(formData.price),
			priority: parseInt(formData.priority) || 0,
			categoryRequirements: formData.categoryRequirements.map(req => ({
				category: req.category,
				quantity: parseInt(req.quantity)
			}))
		});
	};

	return (
		<form ref={formRef} onSubmit={handleSubmit} noValidate className="space-y-4">
			{/* Basic Information */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<FormField id="combo-name" label="Tên combo" required error={errors.name}>
					<input
						type="text"
						name="name"
						value={formData.name}
						onChange={(e) => setField('name', e.target.value)}
						onBlur={handleBlur}
						className={INPUT_CLASS}
						placeholder="Nhập tên combo"
						maxLength="100"
					/>
				</FormField>

				<FormField id="combo-price" label="Giá combo" required error={errors.price}>
					<input
						type="number"
						name="price"
						value={formData.price}
						onChange={(e) => setField('price', e.target.value)}
						onBlur={handleBlur}
						className={INPUT_CLASS}
						placeholder="0"
						min="0"
						step="1000"
					/>
				</FormField>
			</div>

			<FormField id="combo-description" label="Mô tả" error={errors.description}>
				<textarea
					name="description"
					value={formData.description}
					onChange={(e) => setField('description', e.target.value)}
					onBlur={handleBlur}
					className={INPUT_CLASS}
					rows="3"
					placeholder="Mô tả combo (tùy chọn)"
				/>
			</FormField>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<FormField id="combo-priority" label="Độ ưu tiên" hint="Số cao hơn được ưu tiên áp dụng trước">
					<input
						type="number"
						value={formData.priority}
						onChange={(e) => setFormData(prev => ({ ...prev, priority: parseInt(e.target.value) || 0 }))}
						className={INPUT_CLASS}
						placeholder="0"
						min="0"
					/>
				</FormField>

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

			<FormField id="combo-salesChannel" label="Kênh áp dụng">
				<select
					value={formData.salesChannel}
					onChange={(e) => setFormData(prev => ({ ...prev, salesChannel: e.target.value }))}
					className={INPUT_CLASS}
				>
					{SALES_CHANNELS.map(channel => (
						<option key={channel} value={channel}>
							{SALES_CHANNEL_LABELS[channel]}
						</option>
					))}
				</select>
			</FormField>

			{/* Category Requirements */}
			<div role="group" aria-labelledby="combo-requirements-label">
				<div className="flex justify-between items-center mb-3">
					<span id="combo-requirements-label" className="block text-sm font-medium text-gray-700">
						Yêu cầu danh mục
						<span className="text-danger-500 ms-1" aria-hidden="true">*</span>
					</span>
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
							id={`combo-requirement-category-${index}`}
							aria-label={`Danh mục yêu cầu ${index + 1}`}
							aria-required="true"
							aria-invalid={rowInvalid(requirement, 'category') ? 'true' : undefined}
							aria-describedby={errors.categoryRequirements ? 'combo-requirements-error' : undefined}
							value={requirement.category}
							onChange={(e) => updateCategoryRequirement(index, 'category', e.target.value)}
							className={`flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500${rowInvalid(requirement, 'category') ? ROW_ERROR_CLASS : ''}`}
						>
							<option value="">Chọn danh mục</option>
							{categories.map(category => (
								<option key={category} value={category}>
									{category}
								</option>
							))}
						</select>

						<input
							id={`combo-requirement-quantity-${index}`}
							type="number"
							aria-label={`Số lượng yêu cầu ${index + 1}`}
							aria-required="true"
							aria-invalid={rowInvalid(requirement, 'quantity') ? 'true' : undefined}
							aria-describedby={errors.categoryRequirements ? 'combo-requirements-error' : undefined}
							value={requirement.quantity}
							onChange={(e) => updateCategoryRequirement(index, 'quantity', parseInt(e.target.value) || 1)}
							className={`w-20 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-center${rowInvalid(requirement, 'quantity') ? ROW_ERROR_CLASS : ''}`}
							min="1"
						/>

						{formData.categoryRequirements.length > 1 && (
							<button
								type="button"
								onClick={() => removeCategoryRequirement(index)}
								className="text-red-600 hover:text-red-800 p-2"
								aria-label={`Xóa yêu cầu ${index + 1}`}
							>
								<i className="fas fa-trash"></i>
							</button>
						)}
					</div>
				))}

				{errors.categoryRequirements && (
					<p id="combo-requirements-error" role="alert" className="mt-1 text-sm text-danger-500">
						<i className="fas fa-exclamation-circle mr-1" aria-hidden="true"></i>
						{errors.categoryRequirements}
					</p>
				)}
			</div>

			{/* Actions */}
			<div className="flex justify-end space-x-3 pt-4">
				<button type="button" onClick={onCancel} className="btn-secondary">
					Hủy
				</button>
				<button type="submit" className="btn-primary" disabled={submitting}>
					{submitting ? 'Đang lưu...' : combo ? 'Cập nhật' : 'Tạo combo'}
				</button>
			</div>
		</form>
	);
};

const ComboManagement = () => {
	const [combos, setCombos] = useState([]);
	const [categories, setCategories] = useState([]);
	const [loading, setLoading] = useState(true);
	const [showModal, setShowModal] = useState(false);
	const [editingCombo, setEditingCombo] = useState(null);
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

	const handleSubmit = async (comboData) => {
		if (submitting) return;
		setSubmitting(true);
		try {
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
				setEditingCombo(null);
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
					<ComboForm
						combo={editingCombo}
						categories={categories}
						submitting={submitting}
						onSubmit={handleSubmit}
						onCancel={() => setShowModal(false)}
					/>
					</Modal>
			</div>
		</div>
	);
};

export default ComboManagement;
