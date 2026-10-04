import React, { useState } from 'react';
import { toast } from 'react-toastify';
import { adjustStock } from '../../services/stock-api';

const REASON_MAX_LENGTH = 200;

const MODES = [
	{ id: 'delta', label: 'Thêm/bớt' },
	{ id: 'target', label: 'Đặt tồn =' }
];

const StockAdjustPanel = ({ productId, onSubmitted }) => {
	const [mode, setMode] = useState('delta');
	const [value, setValue] = useState('');
	const [reason, setReason] = useState('');
	const [submitting, setSubmitting] = useState(false);

	// Number('') is 0, which would silently pass as a valid integer.
	const parsed = value.trim() === '' ? NaN : Number(value);
	const trimmedReason = reason.trim();
	const valueError = (() => {
		if (value.trim() === '') return null;
		if (!Number.isInteger(parsed)) return 'Nhập số nguyên';
		if (mode === 'delta' && parsed === 0) return 'Số lượng thêm/bớt phải khác 0';
		if (mode === 'target' && parsed < 0) return 'Tồn đặt phải từ 0 trở lên';
		return null;
	})();
	const canSubmit = !submitting && Number.isInteger(parsed) && !valueError && trimmedReason.length > 0;

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (!canSubmit) return;
		setSubmitting(true);
		try {
			await adjustStock(productId, { mode, value: parsed, reason: trimmedReason });
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
		<form onSubmit={handleSubmit} className="space-y-3">
			<h3 className="text-sm font-semibold text-gray-900">Điều chỉnh tồn kho</h3>

			<div className="flex items-center gap-2">
				{MODES.map((m) => (
					<button
						key={m.id}
						type="button"
						onClick={() => setMode(m.id)}
						disabled={submitting}
						className={mode === m.id ? 'btn-primary' : 'btn-secondary'}
					>
						{m.label}
					</button>
				))}
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-start">
				<div>
					<label className="block text-sm font-medium text-gray-700 mb-1">
						{mode === 'delta' ? 'Số lượng (+ thêm, − bớt)' : 'Tồn mới'}
					</label>
					<input
						type="number"
						step="1"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						className={valueError ? 'form-input-error' : 'form-input'}
						placeholder={mode === 'delta' ? 'vd 10 hoặc -3' : 'vd 25'}
						disabled={submitting}
					/>
					{valueError && <p className="text-xs text-danger-600 mt-1">{valueError}</p>}
				</div>
				<div className="sm:col-span-2">
					<label className="block text-sm font-medium text-gray-700 mb-1">
						Lý do * ({reason.length}/{REASON_MAX_LENGTH})
					</label>
					<input
						type="text"
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						maxLength={REASON_MAX_LENGTH}
						className="form-input"
						placeholder="vd Nhập thêm hàng, kiểm kê"
						disabled={submitting}
					/>
				</div>
			</div>

			<div className="flex justify-end">
				<button type="submit" className="btn-primary" disabled={!canSubmit}>
					{submitting ? 'Đang ghi...' : 'Ghi điều chỉnh'}
				</button>
			</div>
		</form>
	);
};

export default StockAdjustPanel;
