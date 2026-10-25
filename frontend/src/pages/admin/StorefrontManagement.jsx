import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { storefrontCreate } from '@sab/shared';
import { settingsService, storefrontAdminService } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import FormField from '../../components/form/FormField';
import StorefrontAccessPanel, { SMTP_BANNER_TEXT } from '../../components/admin/StorefrontAccessPanel';
import { slugify } from '../../utils/slugify';

const VISIBILITY_LABELS = { PUBLIC: 'Công khai', PRIVATE: 'Riêng tư' };

const EMPTY_FORM = { name: '', slug: '', description: '', visibility: 'PUBLIC', isActive: true };

export const toForm = (storefront) => (storefront ? {
	name: storefront.name,
	slug: storefront.slug,
	description: storefront.description || '',
	visibility: storefront.visibility,
	isActive: storefront.isActive
} : { ...EMPTY_FORM });

// A blank description is sent as null: on update the server reads it as "clear", on create as "absent".
export const toPayload = (form) => ({
	name: form.name.trim(),
	slug: form.slug.trim(),
	description: form.description.trim() || null,
	visibility: form.visibility,
	isActive: form.isActive
});

/** First shared-schema message per field, e.g. `{ slug: '...' }`. The server stays authoritative. */
export const validateStorefrontForm = (form) => {
	const result = storefrontCreate.safeParse(toPayload(form));
	const errors = {};
	if (!result.success) {
		for (const issue of result.error.issues) {
			const field = issue.path[0];
			if (typeof field === 'string' && !errors[field]) errors[field] = issue.message;
		}
	}
	return errors;
};

// Returns the new id order after moving `index` by `delta`, or null at an edge.
export const moveId = (ids, index, delta) => {
	const target = index + delta;
	if (target < 0 || target >= ids.length) return null;
	const next = [...ids];
	[next[index], next[target]] = [next[target], next[index]];
	return next;
};

const VisibilityBadge = ({ visibility }) => (
	visibility === 'PRIVATE'
		? <span className="badge badge-warning"><i className="fas fa-lock mr-1"></i>{VISIBILITY_LABELS.PRIVATE}</span>
		: <span className="badge badge-success">{VISIBILITY_LABELS.PUBLIC}</span>
);

const StorefrontForm = ({ storefront, onSubmit, onCancel, submitting }) => {
	const [form, setForm] = useState(() => toForm(storefront));
	const [errors, setErrors] = useState({});
	// The slug follows the name until the admin types in the slug field; an existing
	// storefront keeps its slug because changing it breaks links already shared.
	const slugTouched = useRef(Boolean(storefront));
	const formRef = useRef(null);

	const setField = (name, value) => {
		setForm((prev) => ({ ...prev, [name]: value }));
		setErrors((prev) => {
			if (!prev[name]) return prev;
			const { [name]: _removed, ...rest } = prev;
			return rest;
		});
	};

	const handleName = (value) => {
		setForm((prev) => ({ ...prev, name: value, ...(slugTouched.current ? {} : { slug: slugify(value) }) }));
		setErrors((prev) => ({ ...prev, name: undefined, ...(slugTouched.current ? {} : { slug: undefined }) }));
	};

	const handleSlug = (value) => {
		slugTouched.current = true;
		setField('slug', value.toLowerCase());
	};

	const handleSubmit = (e) => {
		e.preventDefault();
		if (submitting) return;
		const found = validateStorefrontForm(form);
		if (Object.keys(found).length > 0) {
			setErrors(found);
			formRef.current?.querySelector('[aria-invalid="true"]')?.focus();
			return;
		}
		onSubmit(toPayload(form));
	};

	const slugChanged = Boolean(storefront) && form.slug !== storefront.slug;

	return (
		<form ref={formRef} onSubmit={handleSubmit} noValidate className="space-y-4">
			<FormField id="storefront-name" label="Tên gian hàng" required error={errors.name}>
				<input
					type="text"
					value={form.name}
					onChange={(e) => handleName(e.target.value)}
					className="form-input"
					maxLength={80}
				/>
			</FormField>

			<FormField
				id="storefront-slug"
				label="Đường dẫn"
				required
				error={errors.slug}
				hint={`Địa chỉ gian hàng: /s/${form.slug || '...'}`}
			>
				<input
					type="text"
					value={form.slug}
					onChange={(e) => handleSlug(e.target.value)}
					className="form-input font-mono"
					maxLength={60}
				/>
			</FormField>
			{slugChanged && (
				<p role="alert" className="text-sm text-warning-800 bg-warning-100 rounded-md px-3 py-2">
					<i className="fas fa-exclamation-triangle mr-1"></i>
					Đổi đường dẫn sẽ làm hỏng các liên kết đã chia sẻ tới /s/{storefront.slug}.
				</p>
			)}

			<FormField id="storefront-description" label="Mô tả" error={errors.description}>
				<textarea
					value={form.description}
					onChange={(e) => setField('description', e.target.value)}
					className="form-input"
					rows={3}
					maxLength={500}
				/>
			</FormField>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<FormField id="storefront-visibility" label="Hiển thị" error={errors.visibility}>
					<select
						value={form.visibility}
						onChange={(e) => setField('visibility', e.target.value)}
						className="form-input"
					>
						<option value="PUBLIC">{VISIBILITY_LABELS.PUBLIC}: ai cũng xem được</option>
						<option value="PRIVATE">{VISIBILITY_LABELS.PRIVATE}: chỉ người được cấp quyền</option>
					</select>
				</FormField>

				<label className="flex items-center gap-2 md:mt-7 text-sm font-medium text-gray-700">
					<input
						type="checkbox"
						checked={form.isActive}
						onChange={(e) => setField('isActive', e.target.checked)}
						className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
					/>
					Đang hoạt động
				</label>
			</div>

			<div className="flex justify-end space-x-3 pt-2">
				<button type="button" onClick={onCancel} disabled={submitting} className="btn-secondary">Hủy</button>
				<button type="submit" disabled={submitting} className="btn-primary">
					{submitting ? 'Đang lưu...' : storefront ? 'Cập nhật' : 'Tạo gian hàng'}
				</button>
			</div>
		</form>
	);
};

const StorefrontModal = ({ storefront, onClose, onSaved }) => {
	const [submitting, setSubmitting] = useState(false);
	// The access panel follows the saved visibility, not the unsaved select.
	const [saved, setSaved] = useState(storefront);

	const handleSubmit = async (payload) => {
		setSubmitting(true);
		try {
			const response = saved
				? await storefrontAdminService.update(saved._id, payload)
				: await storefrontAdminService.create(payload);
			toast.success(saved ? 'Đã cập nhật gian hàng' : 'Đã tạo gian hàng');
			await onSaved();
			// A new private storefront stays open so rules can be added straight away.
			if (!saved && response.data.visibility === 'PRIVATE') {
				setSaved(response.data);
			} else {
				onClose();
			}
		} catch (error) {
			toast.error(error.message);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-40 p-4">
			<div className="bg-white rounded-lg max-w-2xl w-full max-h-screen overflow-y-auto">
				<div className="p-6 space-y-6">
					<div className="flex justify-between items-center">
						<h2 className="text-xl font-semibold text-gray-900">
							{saved ? 'Chỉnh sửa gian hàng' : 'Thêm gian hàng'}
						</h2>
						<button type="button" onClick={onClose} aria-label="Đóng" className="text-gray-500 hover:text-gray-700">
							<i className="fas fa-times text-xl"></i>
						</button>
					</div>

					<StorefrontForm key={saved?._id || 'new'} storefront={saved} onSubmit={handleSubmit} onCancel={onClose} submitting={submitting} />

					{saved?.visibility === 'PRIVATE' && <StorefrontAccessPanel storefront={saved} />}
					{!saved && (
						<p className="text-sm text-gray-500">Lưu gian hàng riêng tư trước, sau đó thêm quy tắc truy cập.</p>
					)}
				</div>
			</div>
		</div>
	);
};

const StorefrontManagement = () => {
	const [storefronts, setStorefronts] = useState([]);
	const [loading, setLoading] = useState(true);
	const [modal, setModal] = useState({ open: false, storefront: null });
	const [reordering, setReordering] = useState(false);
	const [pendingId, setPendingId] = useState(null);
	const [otpAvailable, setOtpAvailable] = useState(true);

	const load = useCallback(async () => {
		try {
			const response = await storefrontAdminService.list();
			setStorefronts(response.data || []);
		} catch (error) {
			toast.error(error.message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
		// The banner is advisory: a settings failure must not hide the storefront table.
		settingsService.getPublicSettings()
			.then((settings) => setOtpAvailable(settings.otpAvailable !== false))
			.catch(() => {});
	}, [load]);

	const hasPrivate = storefronts.some((storefront) => storefront.visibility === 'PRIVATE');
	const busy = reordering || pendingId !== null;

	const handleMove = async (index, delta) => {
		const next = moveId(storefronts.map((storefront) => storefront._id), index, delta);
		if (!next || busy) return;
		setReordering(true);
		try {
			const response = await storefrontAdminService.reorder(next);
			setStorefronts(response.data || storefronts);
			toast.success('Đã cập nhật thứ tự gian hàng');
		} catch (error) {
			toast.error(error.message);
			await load();
		} finally {
			setReordering(false);
		}
	};

	const handleToggleActive = async (storefront) => {
		if (busy) return;
		setPendingId(storefront._id);
		try {
			await storefrontAdminService.update(storefront._id, { isActive: !storefront.isActive });
			toast.success(storefront.isActive ? 'Đã tắt gian hàng' : 'Đã bật gian hàng');
			await load();
		} catch (error) {
			// e.g. 409 when this is the last active storefront
			toast.error(error.message);
		} finally {
			setPendingId(null);
		}
	};

	const handleDelete = async (storefront) => {
		if (busy) return;
		const result = await Swal.fire({
			title: 'Xác nhận xóa gian hàng',
			text: `Xóa gian hàng "${storefront.name}"? Không thể xóa khi còn sản phẩm, combo hoặc đơn hàng.`,
			icon: 'warning',
			showCancelButton: true,
			confirmButtonColor: '#dc2626',
			cancelButtonColor: '#6b7280',
			confirmButtonText: 'Xóa',
			cancelButtonText: 'Hủy'
		});
		if (!result.isConfirmed) return;
		setPendingId(storefront._id);
		try {
			await storefrontAdminService.remove(storefront._id);
			toast.success('Đã xóa gian hàng');
			await load();
		} catch (error) {
			toast.error(error.message);
		} finally {
			setPendingId(null);
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-64">
				<LoadingSpinner size="large" text="Đang tải danh sách gian hàng..." />
			</div>
		);
	}

	return (
		<div className="p-6">
			<div className="flex justify-between items-center mb-6">
				<div>
					<h1 className="text-2xl font-bold text-gray-900">Quản lý gian hàng</h1>
					<p className="text-gray-600">Mỗi gian hàng có sản phẩm, combo và quyền truy cập riêng</p>
				</div>
				<button onClick={() => setModal({ open: true, storefront: null })} className="btn-primary">
					<i className="fas fa-plus mr-2"></i>
					Thêm gian hàng
				</button>
			</div>

			{hasPrivate && !otpAvailable && (
				<div role="alert" className="mb-4 rounded-md border border-warning-500 bg-warning-100 px-4 py-3 text-sm text-warning-800">
					<i className="fas fa-exclamation-triangle mr-2"></i>
					{SMTP_BANNER_TEXT}
				</div>
			)}

			<div className="card overflow-x-auto">
				<table className="min-w-full divide-y divide-gray-200">
					<thead className="bg-gray-50">
						<tr>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Thứ tự</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tên</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Đường dẫn</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Hiển thị</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Hoạt động</th>
							<th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Hành động</th>
						</tr>
					</thead>
					<tbody className="bg-white divide-y divide-gray-200">
						{storefronts.map((storefront, index) => (
							<tr key={storefront._id} className="hover:bg-gray-50">
								<td className="px-4 py-3 whitespace-nowrap">
									<button
										type="button"
										onClick={() => handleMove(index, -1)}
										disabled={busy || index === 0}
										aria-label={`Đưa ${storefront.name} lên`}
										className="px-2 text-gray-600 hover:text-gray-900 disabled:opacity-30 disabled:cursor-not-allowed"
									>
										<i className="fas fa-arrow-up"></i>
									</button>
									<button
										type="button"
										onClick={() => handleMove(index, 1)}
										disabled={busy || index === storefronts.length - 1}
										aria-label={`Đưa ${storefront.name} xuống`}
										className="px-2 text-gray-600 hover:text-gray-900 disabled:opacity-30 disabled:cursor-not-allowed"
									>
										<i className="fas fa-arrow-down"></i>
									</button>
								</td>
								<td className="px-4 py-3">
									<div className="text-sm font-medium text-gray-900">{storefront.name}</div>
									{storefront.description && (
										<div className="text-sm text-gray-500 line-clamp-1">{storefront.description}</div>
									)}
								</td>
								<td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-700">/s/{storefront.slug}</td>
								<td className="px-4 py-3 whitespace-nowrap"><VisibilityBadge visibility={storefront.visibility} /></td>
								<td className="px-4 py-3 whitespace-nowrap">
									<input
										type="checkbox"
										role="switch"
										checked={storefront.isActive}
										onChange={() => handleToggleActive(storefront)}
										disabled={busy}
										aria-label={`Bật/tắt ${storefront.name}`}
										className="h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:opacity-50"
									/>
									{pendingId === storefront._id && <span className="ml-2 text-xs text-gray-500">Đang lưu...</span>}
								</td>
								<td className="px-4 py-3 whitespace-nowrap text-right text-sm font-medium">
									<button
										onClick={() => setModal({ open: true, storefront })}
										disabled={busy}
										className="text-primary-600 hover:text-primary-900 mr-3 disabled:opacity-50"
									>
										<i className="fas fa-edit mr-1"></i>Sửa
									</button>
									<button
										onClick={() => handleDelete(storefront)}
										disabled={busy}
										className="text-danger-600 hover:text-danger-900 disabled:opacity-50"
									>
										<i className="fas fa-trash mr-1"></i>Xóa
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{reordering && <p className="px-4 py-2 text-sm text-gray-500">Đang sắp xếp...</p>}
			</div>

			{modal.open && (
				<StorefrontModal
					storefront={modal.storefront}
					onClose={() => setModal({ open: false, storefront: null })}
					onSaved={load}
				/>
			)}
		</div>
	);
};

export default StorefrontManagement;
