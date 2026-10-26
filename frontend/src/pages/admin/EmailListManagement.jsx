import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { emailListCreate } from '@sab/shared';
import { emailListService } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import FormField from '../../components/form/FormField';
import EmailImportDialog from '../../components/admin/EmailImportDialog';
import { describePage } from '../../utils/pagination';

const ENTRIES_PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

// Text for the delete confirmation; a list used by rules takes those rules with it.
export const deleteListMessage = (list) => (
	list.ruleCount > 0
		? `Danh sách "${list.name}" đang được ${list.ruleCount} quy tắc gian hàng sử dụng. Xóa danh sách sẽ xóa các quy tắc đó và những gian hàng này sẽ cho ít người vào hơn.`
		: `Xóa danh sách "${list.name}" và ${list.entryCount} email trong đó?`
);

const ListFormModal = ({ list, onClose, onSaved }) => {
	const [name, setName] = useState(list?.name || '');
	const [description, setDescription] = useState(list?.description || '');
	const [errors, setErrors] = useState({});
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (submitting) return;
		const payload = { name: name.trim(), description: description.trim() || null };
		const parsed = emailListCreate.safeParse(payload);
		if (!parsed.success) {
			const found = {};
			for (const issue of parsed.error.issues) {
				if (!found[issue.path[0]]) found[issue.path[0]] = issue.message;
			}
			setErrors(found);
			return;
		}
		setSubmitting(true);
		try {
			const response = list
				? await emailListService.update(list._id, payload)
				: await emailListService.create(payload);
			toast.success(list ? 'Đã cập nhật danh sách' : 'Đã tạo danh sách');
			onSaved(response.data);
		} catch (error) {
			// e.g. EMAIL_LIST_NAME_TAKEN
			toast.error(error.message);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-40 p-4">
			<div role="dialog" aria-modal="true" className="bg-white rounded-lg max-w-md w-full">
				<form onSubmit={handleSubmit} noValidate className="p-6 space-y-4">
					<h2 className="text-xl font-semibold text-gray-900">{list ? 'Đổi tên danh sách' : 'Tạo danh sách email'}</h2>
					<FormField id="email-list-name" label="Tên danh sách" required error={errors.name}>
						<input type="text" value={name} onChange={(e) => setName(e.target.value)} className="form-input" maxLength={80} autoFocus />
					</FormField>
					<FormField id="email-list-description" label="Mô tả" error={errors.description}>
						<textarea value={description} onChange={(e) => setDescription(e.target.value)} className="form-input" rows={2} maxLength={500} />
					</FormField>
					<div className="flex justify-end space-x-3">
						<button type="button" onClick={onClose} disabled={submitting} className="btn-secondary">Hủy</button>
						<button type="submit" disabled={submitting} className="btn-primary">
							{submitting ? 'Đang lưu...' : list ? 'Cập nhật' : 'Tạo danh sách'}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
};

const EntriesPanel = ({ list, refreshKey, onChanged, onAdd }) => {
	const [entries, setEntries] = useState([]);
	const [meta, setMeta] = useState(null);
	const [page, setPage] = useState(1);
	const [searchInput, setSearchInput] = useState('');
	const [search, setSearch] = useState('');
	const [loading, setLoading] = useState(true);
	const [removingId, setRemovingId] = useState(null);
	const requestRef = useRef(0);

	useEffect(() => {
		const timer = setTimeout(() => {
			setSearch(searchInput.trim());
			setPage(1);
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [searchInput]);

	const load = useCallback(async () => {
		// Only the newest request may write state: typing fast would otherwise show an older page.
		const requestId = ++requestRef.current;
		setLoading(true);
		try {
			const response = await emailListService.listEntries(list._id, { page, limit: ENTRIES_PAGE_SIZE, search });
			if (requestId !== requestRef.current) return;
			// The last row of the last page was removed: step back to a page that exists.
			if (response.data.length === 0 && page > 1 && response.meta.totalPages > 0) {
				setPage(response.meta.totalPages);
				return;
			}
			setEntries(response.data);
			setMeta(response.meta);
		} catch (error) {
			if (requestId === requestRef.current) toast.error(error.message);
		} finally {
			if (requestId === requestRef.current) setLoading(false);
		}
	}, [list._id, page, search]);

	useEffect(() => {
		load();
	}, [load, refreshKey]);

	const handleRemove = async (entry) => {
		setRemovingId(entry._id);
		try {
			await emailListService.removeEntry(list._id, entry._id);
			toast.success('Đã xóa email khỏi danh sách');
			await load();
			onChanged();
		} catch (error) {
			toast.error(error.message);
		} finally {
			setRemovingId(null);
		}
	};

	const range = meta && describePage(meta);

	return (
		<div className="card">
			<div className="px-6 py-4 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
				<div>
					<h2 className="text-lg font-semibold text-gray-900">{list.name}</h2>
					{list.description && <p className="text-sm text-gray-600">{list.description}</p>}
				</div>
				<div className="flex items-center gap-3">
					<input
						type="text"
						aria-label="Tìm email"
						value={searchInput}
						onChange={(e) => setSearchInput(e.target.value)}
						placeholder="Tìm email..."
						className="form-input h-10 w-full sm:w-56"
					/>
					<button type="button" onClick={onAdd} className="btn-primary h-10 whitespace-nowrap">
						<i className="fas fa-plus mr-2"></i>Thêm email
					</button>
				</div>
			</div>

			{loading && !meta ? (
				<div className="p-8 text-center"><LoadingSpinner text="Đang tải email..." /></div>
			) : entries.length === 0 ? (
				<p className="p-8 text-center text-gray-600">
					{search ? 'Không tìm thấy email phù hợp' : 'Danh sách chưa có email nào'}
				</p>
			) : (
				<div className={loading ? 'opacity-60 pointer-events-none' : ''}>
					<table className="min-w-full divide-y divide-gray-200">
						<thead className="bg-gray-50">
							<tr>
								<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
								<th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Hành động</th>
							</tr>
						</thead>
						<tbody className="bg-white divide-y divide-gray-200">
							{entries.map((entry) => (
								<tr key={entry._id} className="hover:bg-gray-50">
									<td className="px-6 py-2 text-sm font-mono text-gray-900 break-all">{entry.email}</td>
									<td className="px-6 py-2 text-right text-sm">
										<button
											type="button"
											onClick={() => handleRemove(entry)}
											disabled={removingId !== null}
											aria-label={`Xóa ${entry.email}`}
											className="text-danger-600 hover:text-danger-900 disabled:opacity-50"
										>
											{removingId === entry._id ? 'Đang xóa...' : <i className="fas fa-trash"></i>}
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{meta && meta.total > 0 && (
				<div className="bg-gray-50 px-6 py-3 border-t border-gray-200 flex items-center justify-between">
					<div className="text-sm text-gray-700">Hiển thị {range.from} đến {range.to} trong {meta.total} email</div>
					<div className="flex items-center space-x-2">
						<button type="button" onClick={() => setPage(meta.page - 1)} disabled={loading || !range.hasPrev} aria-label="Trang trước" className="btn-secondary disabled:opacity-50">
							<i className="fas fa-chevron-left"></i>
						</button>
						<span className="px-3 py-2 text-sm text-gray-700">Trang {meta.page} / {meta.totalPages}</span>
						<button type="button" onClick={() => setPage(meta.page + 1)} disabled={loading || !range.hasNext} aria-label="Trang sau" className="btn-secondary disabled:opacity-50">
							<i className="fas fa-chevron-right"></i>
						</button>
					</div>
				</div>
			)}
		</div>
	);
};

const EmailListManagement = () => {
	const [lists, setLists] = useState([]);
	const [loading, setLoading] = useState(true);
	const [selectedId, setSelectedId] = useState(null);
	const [formModal, setFormModal] = useState({ open: false, list: null });
	const [importOpen, setImportOpen] = useState(false);
	const [refreshKey, setRefreshKey] = useState(0);
	const [deletingId, setDeletingId] = useState(null);

	const load = useCallback(async () => {
		try {
			const response = await emailListService.list();
			setLists(response.data || []);
		} catch (error) {
			toast.error(error.message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const selected = lists.find((list) => list._id === selectedId) || null;

	const handleSaved = async (saved) => {
		setFormModal({ open: false, list: null });
		await load();
		if (saved?._id) setSelectedId(saved._id);
	};

	const handleDelete = async (list) => {
		const result = await Swal.fire({
			title: 'Xác nhận xóa danh sách',
			text: deleteListMessage(list),
			icon: 'warning',
			showCancelButton: true,
			confirmButtonColor: '#dc2626',
			cancelButtonColor: '#6b7280',
			confirmButtonText: 'Xóa',
			cancelButtonText: 'Hủy'
		});
		if (!result.isConfirmed) return;
		setDeletingId(list._id);
		try {
			await emailListService.remove(list._id);
			toast.success('Đã xóa danh sách email');
			if (selectedId === list._id) setSelectedId(null);
			await load();
		} catch (error) {
			toast.error(error.message);
		} finally {
			setDeletingId(null);
		}
	};

	const handleImported = () => {
		setRefreshKey((key) => key + 1);
		load();
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-64">
				<LoadingSpinner size="large" text="Đang tải danh sách email..." />
			</div>
		);
	}

	return (
		<div>
			<div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
				<div>
					<h1 className="text-2xl font-bold text-gray-900">Danh sách email</h1>
					<p className="text-gray-600">Dùng làm quy tắc truy cập cho gian hàng riêng tư</p>
				</div>
				<button onClick={() => setFormModal({ open: true, list: null })} className="btn-primary">
					<i className="fas fa-plus mr-2"></i>Tạo danh sách
				</button>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<div className="card lg:col-span-1 self-start">
					{lists.length === 0 ? (
						<p className="p-6 text-center text-gray-600">Chưa có danh sách nào</p>
					) : (
						<ul className="divide-y divide-gray-100">
							{lists.map((list) => (
								<li key={list._id} className={list._id === selectedId ? 'bg-primary-50' : ''}>
									<button
										type="button"
										onClick={() => setSelectedId(list._id)}
										className="w-full text-left px-4 py-3 hover:bg-gray-50"
									>
										<div className="text-sm font-medium text-gray-900">{list.name}</div>
										<div className="text-xs text-gray-500">
											{list.entryCount} email · dùng trong {list.ruleCount} quy tắc
										</div>
									</button>
									<div className="px-4 pb-3 flex gap-4 text-sm">
										<button type="button" onClick={() => setFormModal({ open: true, list })} disabled={deletingId !== null} className="text-primary-600 hover:text-primary-900 disabled:opacity-50">
											<i className="fas fa-edit mr-1"></i>Đổi tên
										</button>
										<button type="button" onClick={() => handleDelete(list)} disabled={deletingId !== null} className="text-danger-600 hover:text-danger-900 disabled:opacity-50">
											{deletingId === list._id ? 'Đang xóa...' : <><i className="fas fa-trash mr-1"></i>Xóa</>}
										</button>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>

				<div className="lg:col-span-2">
					{selected ? (
						<EntriesPanel
							key={selected._id}
							list={selected}
							refreshKey={refreshKey}
							onChanged={load}
							onAdd={() => setImportOpen(true)}
						/>
					) : (
						<div className="card p-8 text-center text-gray-600">Chọn một danh sách để xem email</div>
					)}
				</div>
			</div>

			{formModal.open && (
				<ListFormModal list={formModal.list} onClose={() => setFormModal({ open: false, list: null })} onSaved={handleSaved} />
			)}
			{importOpen && selected && (
				<EmailImportDialog
					isOpen
					listId={selected._id}
					listName={selected.name}
					onClose={() => setImportOpen(false)}
					onImported={handleImported}
				/>
			)}
		</div>
	);
};

export default EmailListManagement;
