import React, { useDeferredValue, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { emailListCreate } from '@sab/shared';
import { emailListService } from '../../services/api';
import { readEmailFile, EMAIL_FILE_ACCEPT } from '../../lib/read-email-file';
import {
	IMPORT_EMAILS_MAX,
	buildImportPreview,
	chunkEmails,
	importToastMessage
} from '../../utils/email-import';
import LoadingSpinner from '../LoadingSpinner';

export const ImportPreview = ({ preview }) => (
	<div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm space-y-2" aria-live="polite">
		<div className="flex flex-wrap gap-x-6 gap-y-1">
			<span className="text-green-700"><strong>{preview.validCount}</strong> email hợp lệ</span>
			<span className="text-gray-600"><strong>{preview.duplicateCount}</strong> trùng đã loại</span>
			<span className={preview.invalidCount ? 'text-danger-600' : 'text-gray-600'}>
				<strong>{preview.invalidCount}</strong> không hợp lệ
			</span>
		</div>
		{preview.tooMany && (
			<p className="text-danger-600">
				Tối đa {IMPORT_EMAILS_MAX.toLocaleString('vi-VN')} email mỗi lần. Hãy chia nhỏ danh sách.
			</p>
		)}
		{preview.invalidSample.length > 0 && (
			<div>
				<p className="text-gray-600">
					{preview.invalidCount > preview.invalidSample.length
						? `${preview.invalidSample.length} giá trị không hợp lệ đầu tiên (sẽ bị bỏ qua):`
						: 'Giá trị không hợp lệ (sẽ bị bỏ qua):'}
				</p>
				<ul className="mt-1 max-h-28 overflow-y-auto font-mono text-xs text-danger-600 break-all">
					{preview.invalidSample.map((token) => <li key={token}>{token}</li>)}
				</ul>
			</div>
		)}
	</div>
);

/** A list name suggested by an uploaded file: its name without the extension, cut to the schema's limit. */
export const listNameFromFile = (fileName) => {
	const base = String(fileName || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();
	return base.slice(0, 80);
};

// Adds the pasted/uploaded addresses to one list. Parsing is the shared parseEmailList; the server
// stays the authority and reports how many were new. `onImported` receives the summed counts.
// Parents mount it only while open, so every open starts with an empty textarea.
//
// Without `listId` the dialog creates the list first: it asks for a name (suggested from the
// uploaded file) and calls `onCreateList(name)`, which returns the new list. The created list is
// kept, so a retry after a failed upload adds to it instead of creating a second one.
const EmailImportDialog = ({ isOpen, listId, listName, onClose, onImported, onCreateList }) => {
	const [createdList, setCreatedList] = useState(null);
	const creating = !listId && !createdList;
	const [newName, setNewName] = useState('');
	const [nameError, setNameError] = useState(null);
	const [text, setText] = useState('');
	const [reading, setReading] = useState(false);
	const [fileError, setFileError] = useState(null);
	const [saving, setSaving] = useState(false);
	const [progress, setProgress] = useState(null);

	const deferredText = useDeferredValue(text);
	const preview = useMemo(() => buildImportPreview(deferredText), [deferredText]);
	const stale = deferredText !== text;
	const busy = reading || saving;
	const canSave = !busy && !stale && preview.validCount > 0 && !preview.tooMany;

	if (!isOpen) return null;

	const handleClose = () => {
		if (saving) return;
		// The list survives a failed upload; say where it is so a reopen does not start a second one.
		if (createdList) toast.info(`Danh sách "${createdList.name}" đã được tạo; thêm tiếp email ở tab Danh sách email`);
		onClose();
	};

	const handleFile = async (event) => {
		const file = event.target.files?.[0];
		event.target.value = '';
		if (!file) return;
		setFileError(null);
		setReading(true);
		try {
			const fileText = await readEmailFile(file);
			setText((previous) => (previous.trim() ? `${previous}\n${fileText}` : fileText));
			if (creating) setNewName((previous) => previous.trim() || listNameFromFile(file.name));
		} catch (error) {
			setFileError(error.message);
		} finally {
			setReading(false);
		}
	};

	const handleSave = async () => {
		if (!canSave) return;
		if (creating) {
			const parsed = emailListCreate.safeParse({ name: newName });
			if (!parsed.success) {
				setNameError(parsed.error.issues[0].message);
				return;
			}
			setNameError(null);
		}
		const chunks = chunkEmails(preview.emails);
		let added = 0;
		let skipped = 0;
		setSaving(true);
		setProgress({ done: 0, total: preview.validCount });
		try {
			let targetId = listId || createdList?._id;
			if (!targetId) {
				const list = await onCreateList(newName.trim());
				setCreatedList(list);
				targetId = list._id;
			}
			let done = 0;
			for (const chunk of chunks) {
				const response = await emailListService.addEntries(targetId, chunk);
				added += response.data.added;
				skipped += response.data.skipped;
				done += chunk.length;
				setProgress({ done, total: preview.validCount });
			}
			toast.success(importToastMessage({ added, skipped }));
			onImported({ added, skipped });
			setText('');
			onClose();
		} catch (error) {
			// Earlier chunks are already stored, so the list view must refresh even though this failed.
			toast.error(added > 0 ? `${error.message} (đã thêm ${added} email trước khi lỗi)` : error.message);
			if (added > 0) onImported({ added, skipped });
		} finally {
			setSaving(false);
			setProgress(null);
		}
	};

	return (
		<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="email-import-title"
				className="bg-white rounded-lg max-w-2xl w-full max-h-screen overflow-y-auto"
			>
				<div className="p-6 space-y-4">
					<div className="flex justify-between items-start">
						<div>
							<h2 id="email-import-title" className="text-xl font-semibold text-gray-900">
								{listId ? 'Thêm email' : 'Tải lên danh sách mới'}
							</h2>
							{(listName || createdList) && (
								<p className="text-sm text-gray-600">Vào danh sách: <strong>{listName || createdList.name}</strong></p>
							)}
						</div>
						<button type="button" onClick={handleClose} disabled={saving} aria-label="Đóng" className="text-gray-500 hover:text-gray-700 disabled:opacity-50">
							<i className="fas fa-times text-xl"></i>
						</button>
					</div>

					{creating && (
						<div>
							<label htmlFor="email-import-name" className="block text-sm font-medium text-gray-700 mb-1">
								Tên danh sách <span className="text-danger-500">*</span>
							</label>
							<input
								id="email-import-name"
								type="text"
								value={newName}
								onChange={(e) => { setNewName(e.target.value); setNameError(null); }}
								disabled={saving}
								maxLength={80}
								aria-invalid={Boolean(nameError)}
								aria-describedby={nameError ? 'email-import-name-error' : undefined}
								placeholder="VD: Lớp K66 CNTT (tự điền khi chọn file)"
								className="form-input"
							/>
							{nameError && <p id="email-import-name-error" role="alert" className="mt-1 text-sm text-danger-500">{nameError}</p>}
						</div>
					)}

					<div>
						<label htmlFor="email-import-text" className="block text-sm font-medium text-gray-700 mb-1">
							Dán email (mỗi dòng một email hoặc danh sách CSV)
						</label>
						<textarea
							id="email-import-text"
							value={text}
							onChange={(e) => setText(e.target.value)}
							disabled={saving}
							rows={8}
							className="form-input font-mono text-sm"
							placeholder={'a@truong.edu.vn\nb@truong.edu.vn'}
						/>
					</div>

					<div>
						<label htmlFor="email-import-file" className="block text-sm font-medium text-gray-700 mb-1">
							Hoặc tải file (.csv, .txt, .xlsx; tối đa 5 MB)
						</label>
						<input
							id="email-import-file"
							type="file"
							accept={EMAIL_FILE_ACCEPT}
							onChange={handleFile}
							disabled={busy}
							className="form-input"
						/>
						{reading && (
							<div className="mt-2 text-sm text-blue-600 flex items-center">
								<LoadingSpinner size="small" />
								<span className="ml-2">Đang đọc file...</span>
							</div>
						)}
						{fileError && <p role="alert" className="mt-1 text-sm text-danger-500">{fileError}</p>}
					</div>

					{text.trim() !== '' && <ImportPreview preview={preview} />}

					{progress && (
						<div aria-live="polite">
							<div className="h-2 w-full rounded bg-gray-200 overflow-hidden">
								<div className="h-2 bg-blue-600 transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
							</div>
							<p className="mt-1 text-sm text-gray-600">Đang thêm {progress.done} / {progress.total} email...</p>
						</div>
					)}

					<div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-2">
						<button type="button" onClick={handleClose} disabled={saving} className="btn-secondary">Hủy</button>
						<button type="button" onClick={handleSave} disabled={!canSave} className="btn-primary">
							{saving ? 'Đang thêm...' : `Thêm ${preview.validCount} email`}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
};

export default EmailImportDialog;
