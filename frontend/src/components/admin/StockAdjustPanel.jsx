import React, { useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { adminService } from '../../services/api';
import useFieldErrors from '../../hooks/use-field-errors';
import FormField from '../form/FormField';

const REASON_MAX_LENGTH = 200;
// Same ceiling as the server: far above any real stock count.
const MAX_ABS_VALUE = 1_000_000_000;

const MODES = [
	{ id: 'delta', label: 'Thêm/bớt' },
	{ id: 'target', label: 'Đặt tồn =' }
];

// Client rules mirror parseAdjustment in backend/routes/admin/stock.js (the server stays authoritative).
const STOCK_RULES = {
	value: (value, values) => {
		const text = String(value).trim();
		if (text === '') return values.mode === 'delta' ? 'Số lượng thêm/bớt là bắt buộc' : 'Tồn mới là bắt buộc';
		const n = Number(text);
		if (!Number.isInteger(n) || Math.abs(n) > MAX_ABS_VALUE) return 'Giá trị phải là số nguyên hợp lệ';
		if (values.mode === 'delta' && n === 0) return 'Số lượng thêm/bớt phải khác 0';
		if (values.mode === 'target' && n < 0) return 'Tồn kho đặt tới không được âm';
		return null;
	},
	reason: (value) => {
		const length = value.trim().length;
		return length < 1 || length > REASON_MAX_LENGTH ? `Lý do là bắt buộc (1-${REASON_MAX_LENGTH} ký tự)` : null;
	}
};

// `variants` is empty for a product without options; otherwise the admin must pick which one to adjust.
const StockAdjustPanel = ({ productId, variants = [], onSubmitted }) => {
	const [mode, setMode] = useState('delta');
	const [value, setValue] = useState('');
	const [reason, setReason] = useState('');
	const [variantId, setVariantId] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const { errors, validateField, onFieldChange, validateAll, focusFirstError } = useFieldErrors(STOCK_RULES);
	const formRef = useRef(null);

	const needsVariant = variants.length > 0;
	const valuesWith = (patch) => ({ mode, value, reason, variantId, needsVariant, ...patch });

	const handleModeChange = (nextMode) => {
		setMode(nextMode);
		// The same number can be valid in one mode and not in the other.
		onFieldChange('value', value, valuesWith({ mode: nextMode }));
	};

	const handleValueChange = (e) => {
		setValue(e.target.value);
		onFieldChange('value', e.target.value, valuesWith({ value: e.target.value }));
	};

	const handleReasonChange = (e) => {
		setReason(e.target.value);
		onFieldChange('reason', e.target.value, valuesWith({ reason: e.target.value }));
	};

	const handleVariantChange = (e) => {
		setVariantId(e.target.value);
		onFieldChange('variantId', e.target.value, valuesWith({ variantId: e.target.value }));
	};

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (submitting) return;
		if (!validateAll(valuesWith({}))) {
			focusFirstError(formRef);
			return;
		}
		setSubmitting(true);
		try {
			await adminService.adjustStock(productId, {
				mode,
				value: Number(value),
				reason: reason.trim(),
				...(needsVariant && { variantId })
			});
			toast.success('Đã ghi điều chỉnh — tồn sẽ cập nhật trong giây lát');
			setValue('');
			setReason('');
			if (onSubmitted) onSubmitted();
		} catch (error) {
			toast.error(error.message);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form ref={formRef} onSubmit={handleSubmit} noValidate className="space-y-3">
			<h3 className="text-sm font-semibold text-gray-900">Điều chỉnh tồn kho</h3>

			<div className="flex items-center gap-2">
				{MODES.map((m) => (
					<button
						key={m.id}
						type="button"
						onClick={() => handleModeChange(m.id)}
						disabled={submitting}
						className={mode === m.id ? 'btn-primary' : 'btn-secondary'}
					>
						{m.label}
					</button>
				))}
			</div>

			{needsVariant && (
				<div className="sm:max-w-xs">
					<FormField id="stock-adjust-variant" label="Phân loại" required error={errors.variantId}>
						<select
							value={variantId}
							onChange={handleVariantChange}
							onBlur={() => validateField('variantId', variantId, valuesWith({}))}
							className="form-input"
							disabled={submitting}
						>
							<option value="">Chọn phân loại</option>
							{variants.map((variant) => (
								<option key={variant._id} value={variant._id}>
									{variant.label || 'Mặc định'} (tồn {variant.stockQuantity ?? 0}){variant.archivedAt ? ' - đã lưu trữ' : ''}
								</option>
							))}
						</select>
					</FormField>
				</div>
			)}

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-start">
				<FormField
					id="stock-adjust-value"
					label={mode === 'delta' ? 'Số lượng (+ thêm, − bớt)' : 'Tồn mới'}
					required
					error={errors.value}
				>
					<input
						type="number"
						step="1"
						value={value}
						onChange={handleValueChange}
						onBlur={() => validateField('value', value, valuesWith({}))}
						className="form-input"
						placeholder={mode === 'delta' ? 'vd 10 hoặc -3' : 'vd 25'}
						disabled={submitting}
					/>
				</FormField>
				<div className="sm:col-span-2">
					<FormField
						id="stock-adjust-reason"
						label={`Lý do (${reason.length}/${REASON_MAX_LENGTH})`}
						required
						error={errors.reason}
					>
						<input
							type="text"
							value={reason}
							onChange={handleReasonChange}
							onBlur={() => validateField('reason', reason, valuesWith({}))}
							maxLength={REASON_MAX_LENGTH}
							className="form-input"
							placeholder="vd Nhập thêm hàng, kiểm kê"
							disabled={submitting}
						/>
					</FormField>
				</div>
			</div>

			<div className="flex justify-end">
				<button type="submit" className="btn-primary" disabled={submitting}>
					{submitting ? 'Đang ghi...' : 'Ghi điều chỉnh'}
				</button>
			</div>
		</form>
	);
};

export default StockAdjustPanel;
