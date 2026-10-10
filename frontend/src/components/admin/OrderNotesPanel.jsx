import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { adminService, formatDate } from '../../services/api';
import FormField from '../form/FormField';
import { orderNotes } from '@sab/shared';
import useFieldErrors from '../../hooks/use-field-errors';
import { leftoverIssues } from '../../lib/schema-rules';
import { NOTES_FIELDS, NOTES_RULES, toNotesPayload } from './order-notes-rules';

const MAX_NOTE_LENGTH = 500;

// Notes stay editable in every status, including final ones. Saving is
// explicit (no autosave) so a half-typed note never overwrites the customer's.
const OrderNotesPanel = ({ order, onSaved }) => {
	const savedNote = order.additionalNote || '';
	const [additionalNote, setAdditionalNote] = useState(savedNote);
	const [internalNote, setInternalNote] = useState('');
	const [saving, setSaving] = useState(false);
	const { errors, validateField, onFieldChange, validateAll, setServerErrors, focusFirstError, reset } = useFieldErrors(NOTES_RULES);
	const panelRef = useRef(null);

	useEffect(() => {
		setAdditionalNote(savedNote);
		setInternalNote('');
		reset();
	}, [order._id, savedNote, reset]);

	const trimmedInternal = internalNote.trim();
	const customerNoteChanged = additionalNote !== savedNote;
	const hasChanges = customerNoteChanged || trimmedInternal.length > 0;
	const internalNotes = order.internalNotes || [];

	const values = { additionalNote, savedNote, note: internalNote };

	const handleSave = async () => {
		if (!validateAll(values)) {
			focusFirstError(panelRef);
			return;
		}
		// A schema complaint that belongs to no field (neither note present) has nowhere else to go.
		const payload = toNotesPayload(values);
		const unplaced = leftoverIssues(orderNotes, payload, NOTES_FIELDS);
		if (unplaced.length > 0) {
			toast.error(unplaced.map(({ message }) => message).join('. '));
			return;
		}

		setSaving(true);
		try {
			const response = await adminService.updateOrderNotes(order._id, payload);
			toast.success(response.message || 'Đã lưu ghi chú');
			// Cleared here, not by the effect: a note-only save leaves _id and the
			// customer note unchanged, and a second click would append it again.
			setInternalNote('');
			reset();
			if (response.data) onSaved(response.data);
		} catch (error) {
			if (error.status === 400 && error.fieldErrors?.length) {
				setServerErrors(error).forEach(({ message }) => toast.error(message));
				focusFirstError(panelRef);
			} else {
				toast.error(error.message || 'Lỗi khi lưu ghi chú');
			}
		} finally {
			setSaving(false);
		}
	};

	return (
		<div ref={panelRef} className="space-y-3">
			<p className="block text-sm font-medium text-gray-700">Ghi chú</p>

			<FormField id="order-customer-note" label="Ghi chú của khách" error={errors.additionalNote} hint={`${additionalNote.length}/${MAX_NOTE_LENGTH}`} hintVisualOnly>
				<textarea
					className="w-full border rounded px-3 py-2 text-sm"
					rows={2}
					maxLength={MAX_NOTE_LENGTH}
					value={additionalNote}
					onChange={(e) => {
						setAdditionalNote(e.target.value);
						onFieldChange('additionalNote', e.target.value, { ...values, additionalNote: e.target.value });
					}}
					onBlur={(e) => validateField('additionalNote', e.target.value, values)}
					disabled={saving}
				/>
			</FormField>

			<FormField id="order-internal-note" label="Thêm ghi chú nội bộ" error={errors.note} hint={`${internalNote.length}/${MAX_NOTE_LENGTH}`} hintVisualOnly>
				<textarea
					className="w-full border rounded px-3 py-2 text-sm"
					rows={2}
					maxLength={MAX_NOTE_LENGTH}
					value={internalNote}
					onChange={(e) => {
						setInternalNote(e.target.value);
						onFieldChange('note', e.target.value, { ...values, note: e.target.value });
					}}
					onBlur={(e) => validateField('note', e.target.value, values)}
					disabled={saving}
				/>
			</FormField>

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
