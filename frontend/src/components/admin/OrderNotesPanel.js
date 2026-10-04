import React, { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { adminService, formatDate } from '../../services/api';

const MAX_NOTE_LENGTH = 500;

// Notes stay editable in every status, including final ones. Saving is
// explicit (no autosave) so a half-typed note never overwrites the customer's.
const OrderNotesPanel = ({ order, onSaved }) => {
	const savedNote = order.additionalNote || '';
	const [additionalNote, setAdditionalNote] = useState(savedNote);
	const [internalNote, setInternalNote] = useState('');
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setAdditionalNote(savedNote);
		setInternalNote('');
	}, [order._id, savedNote]);

	const trimmedInternal = internalNote.trim();
	const customerNoteChanged = additionalNote !== savedNote;
	const hasChanges = customerNoteChanged || trimmedInternal.length > 0;
	const internalNotes = order.internalNotes || [];

	const handleSave = async () => {
		const payload = {};
		if (customerNoteChanged) payload.additionalNote = additionalNote.trim();
		if (trimmedInternal) payload.note = trimmedInternal;

		setSaving(true);
		try {
			const response = await adminService.updateOrderNotes(order._id, payload);
			toast.success(response.message || 'Đã lưu ghi chú');
			// Cleared here, not by the effect: a note-only save leaves _id and the
			// customer note unchanged, and a second click would append it again.
			setInternalNote('');
			if (response.data) onSaved(response.data);
		} catch (error) {
			toast.error(error.message || 'Lỗi khi lưu ghi chú');
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-3">
			<label className="block text-sm font-medium text-gray-700">Ghi chú</label>

			<div>
				<label className="block text-xs text-gray-600 mb-1" htmlFor="order-customer-note">
					Ghi chú của khách
				</label>
				<textarea
					id="order-customer-note"
					className="w-full border rounded px-3 py-2 text-sm"
					rows={2}
					maxLength={MAX_NOTE_LENGTH}
					value={additionalNote}
					onChange={(e) => setAdditionalNote(e.target.value)}
					disabled={saving}
				/>
			</div>

			<div>
				<label className="block text-xs text-gray-600 mb-1" htmlFor="order-internal-note">
					Thêm ghi chú nội bộ
				</label>
				<textarea
					id="order-internal-note"
					className="w-full border rounded px-3 py-2 text-sm"
					rows={2}
					maxLength={MAX_NOTE_LENGTH}
					value={internalNote}
					onChange={(e) => setInternalNote(e.target.value)}
					disabled={saving}
				/>
			</div>

			<button
				type="button"
				onClick={handleSave}
				disabled={!hasChanges || saving}
				className="btn btn-primary px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{saving ? 'Đang lưu…' : 'Lưu'}
			</button>

			{internalNotes.length > 0 && (
				<div>
					<p className="text-xs text-gray-600 mb-1">Ghi chú nội bộ (chỉ admin thấy)</p>
					<ul className="space-y-2">
						{internalNotes.map((entry, index) => (
							<li key={index} className="text-sm bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
								<div className="text-gray-900 whitespace-pre-wrap">{entry.note}</div>
								<div className="text-xs text-gray-500 mt-1">
									{entry.by} • {formatDate(entry.at)}
								</div>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
};

export default OrderNotesPanel;
