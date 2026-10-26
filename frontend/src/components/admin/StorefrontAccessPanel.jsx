import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { accessRuleCreate } from '@sab/shared';
import { emailListService, storefrontAdminService } from '../../services/api';
import LoadingSpinner from '../LoadingSpinner';
import EmailImportDialog from './EmailImportDialog';

const OR_HINT = 'Người xem được vào nếu khớp BẤT KỲ quy tắc nào (OR)';
export const SMTP_BANNER_TEXT =
	'Chưa bật SMTP: khách không nhận được mã đăng nhập qua email, chỉ còn đăng nhập bằng Google (nếu đã nhập Google Client ID ở trang Cài đặt)';

const TABS = [
	{ type: 'EMAIL', label: 'Email', placeholder: 'ten@truong.edu.vn' },
	{ type: 'DOMAIN', label: 'Tên miền', placeholder: 'truong.edu.vn' },
	{ type: 'LIST', label: 'Danh sách email' }
];

const TYPE_LABELS = { EMAIL: 'Email', DOMAIN: 'Tên miền', LIST: 'Danh sách' };

/** The POST body for the active tab, or the first schema message. The server re-validates. */
export const buildRuleRequest = (type, value, emailListId) => {
	const candidate = type === 'LIST' ? { type, emailListId } : { type, value };
	const result = accessRuleCreate.safeParse(candidate);
	return result.success
		? { payload: candidate }
		: { error: type === 'LIST' && !emailListId ? 'Hãy chọn một danh sách email' : result.error.issues[0].message };
};

export const RuleSummary = ({ rule }) => (
	<>
		<span className="badge badge-primary mr-2">{TYPE_LABELS[rule.type] || rule.type}</span>
		{rule.type === 'LIST' ? (
			<span>
				{rule.emailListName || 'Danh sách đã xóa'}
				<span className="text-gray-500"> ({rule.entryCount ?? 0} email)</span>
			</span>
		) : (
			<span className="font-mono text-sm">{rule.type === 'DOMAIN' ? `@${rule.value}` : rule.value}</span>
		)}
	</>
);

const StorefrontAccessPanel = ({ storefront }) => {
	const storefrontId = storefront._id;
	const [rules, setRules] = useState([]);
	const [lists, setLists] = useState([]);
	const [loading, setLoading] = useState(true);
	const [tab, setTab] = useState('EMAIL');
	const [value, setValue] = useState('');
	const [listId, setListId] = useState('');
	const [formError, setFormError] = useState(null);
	const [adding, setAdding] = useState(false);
	const [removingId, setRemovingId] = useState(null);
	const [uploadOpen, setUploadOpen] = useState(false);

	const load = useCallback(async () => {
		try {
			const [rulesResponse, listsResponse] = await Promise.all([
				storefrontAdminService.listRules(storefrontId),
				emailListService.list()
			]);
			setRules(rulesResponse.data || []);
			setLists(listsResponse.data || []);
		} catch (error) {
			toast.error(error.message);
		} finally {
			setLoading(false);
		}
	}, [storefrontId]);

	useEffect(() => {
		setLoading(true);
		load();
	}, [load]);

	const addRule = async (type, ruleValue, ruleListId) => {
		const { payload, error } = buildRuleRequest(type, ruleValue, ruleListId);
		if (error) {
			setFormError(error);
			return false;
		}
		setFormError(null);
		setAdding(true);
		try {
			await storefrontAdminService.addRule(storefrontId, payload);
			toast.success('Đã thêm quy tắc truy cập');
			await load();
			return true;
		} catch (err) {
			setFormError(err.message);
			toast.error(err.message);
			return false;
		} finally {
			setAdding(false);
		}
	};

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (adding) return;
		if (await addRule(tab, value.trim(), listId)) {
			setValue('');
			setListId('');
		}
	};

	const switchTab = (type) => {
		setTab(type);
		setFormError(null);
	};

	const handleRemove = async (rule) => {
		const result = await Swal.fire({
			title: 'Xóa quy tắc',
			text: 'Người chỉ khớp quy tắc này sẽ không còn vào được gian hàng. Tiếp tục?',
			icon: 'warning',
			showCancelButton: true,
			confirmButtonColor: '#dc2626',
			cancelButtonColor: '#6b7280',
			confirmButtonText: 'Xóa',
			cancelButtonText: 'Hủy'
		});
		if (!result.isConfirmed) return;
		setRemovingId(rule._id);
		try {
			await storefrontAdminService.removeRule(storefrontId, rule._id);
			toast.success('Đã xóa quy tắc');
			await load();
		} catch (error) {
			toast.error(error.message);
		} finally {
			setRemovingId(null);
		}
	};

	// The upload dialog creates the list, then this links it to the storefront before the
	// emails are added. A failed link is reported but does not stop the upload: the list is
	// still there to pick from the "Danh sách email" tab.
	const createLinkedList = async (name) => {
		const created = (await emailListService.create({ name })).data;
		try {
			await storefrontAdminService.addRule(storefrontId, { type: 'LIST', emailListId: created._id });
			toast.success('Đã tạo danh sách và thêm quy tắc');
		} catch (error) {
			toast.error(`Đã tạo danh sách nhưng chưa gắn vào gian hàng: ${error.message}`);
		}
		load();
		return created;
	};

	if (loading) {
		return <LoadingSpinner size="small" text="Đang tải quy tắc truy cập..." />;
	}

	const activeTab = TABS.find((item) => item.type === tab);

	return (
		<section aria-label="Quyền truy cập" className="space-y-3 rounded-lg border border-gray-200 p-4">
			<div>
				<h3 className="text-base font-semibold text-gray-900">
					<i className="fas fa-lock mr-2 text-gray-500"></i>Quyền truy cập
				</h3>
				<p className="text-sm text-gray-600">{OR_HINT}</p>
			</div>

			{rules.length === 0 ? (
				<p className="text-sm text-warning-800 bg-warning-100 rounded-md px-3 py-2">
					Chưa có quy tắc nào: chỉ admin và seller xem được gian hàng này.
				</p>
			) : (
				<ul className="divide-y divide-gray-100">
					{rules.map((rule) => (
						<li key={rule._id} className="flex items-center justify-between gap-3 py-2 text-sm text-gray-900">
							<div className="min-w-0 break-all"><RuleSummary rule={rule} /></div>
							<button
								type="button"
								onClick={() => handleRemove(rule)}
								disabled={removingId === rule._id}
								className="shrink-0 text-danger-600 hover:text-danger-900 disabled:opacity-50"
								aria-label="Xóa quy tắc"
							>
								{removingId === rule._id ? 'Đang xóa...' : <i className="fas fa-trash"></i>}
							</button>
						</li>
					))}
				</ul>
			)}

			<div role="tablist" aria-label="Loại quy tắc" className="flex flex-wrap gap-2">
				{TABS.map((item) => (
					<button
						key={item.type}
						type="button"
						role="tab"
						aria-selected={tab === item.type}
						onClick={() => switchTab(item.type)}
						className={`h-9 px-3 rounded-md text-sm font-medium ${tab === item.type ? 'bg-primary-100 text-primary-700' : 'text-gray-700 hover:bg-gray-100'}`}
					>
						{item.label}
					</button>
				))}
			</div>

			<form onSubmit={handleSubmit} noValidate className="flex flex-col sm:flex-row gap-2 sm:items-center">
				{tab === 'LIST' ? (
					<select
						aria-label="Danh sách email"
						value={listId}
						onChange={(e) => setListId(e.target.value)}
						className="form-input h-10 flex-1"
					>
						<option value="">Chọn danh sách email</option>
						{lists.map((list) => (
							<option key={list._id} value={list._id}>{list.name} ({list.entryCount} email)</option>
						))}
					</select>
				) : (
					<input
						type="text"
						aria-label={activeTab.label}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder={activeTab.placeholder}
						className="form-input h-10 flex-1"
					/>
				)}
				<button type="submit" disabled={adding} className="btn-primary h-10 whitespace-nowrap">
					{adding ? 'Đang thêm...' : 'Thêm quy tắc'}
				</button>
			</form>

			{formError && <p role="alert" className="text-sm text-danger-500">{formError}</p>}

			<div>
				<button type="button" onClick={() => setUploadOpen(true)} className="btn-secondary h-10 w-full sm:w-auto">
					<i className="fas fa-file-upload mr-2"></i>Tải lên danh sách mới
				</button>
				<p className="mt-1 text-xs text-gray-500">File .csv, .txt, .xlsx hoặc dán email; danh sách được tạo và gắn ngay vào gian hàng này.</p>
			</div>

			{uploadOpen && (
				<EmailImportDialog
					isOpen
					onCreateList={createLinkedList}
					onClose={() => setUploadOpen(false)}
					onImported={load}
				/>
			)}
		</section>
	);
};

export default StorefrontAccessPanel;
