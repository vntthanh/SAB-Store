import React, { useState } from 'react';
import { toast } from 'react-toastify';
import { MAX_OPTION_VALUES, OPTION_TEXT_MAX } from '@sab/shared';
import { createOption, createValue, moveItem } from './variant-setup';

const SMALL_BUTTON =
	'inline-flex items-center justify-center w-9 h-9 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed';

const OptionCard = ({ option, index, count, onUpdate, onMove, onRemove }) => {
	const [draft, setDraft] = useState('');

	const addValue = () => {
		const text = draft.trim();
		if (!text) return;
		if (option.values.some((value) => value.text.trim() === text)) {
			toast.warn(`Giá trị "${text}" đã có trong phân loại này`);
			return;
		}
		if (option.values.length >= MAX_OPTION_VALUES) {
			toast.warn(`Mỗi phân loại tối đa ${MAX_OPTION_VALUES} giá trị`);
			return;
		}
		onUpdate({ ...option, values: [...option.values, createValue(text)] });
		setDraft('');
	};

	const renameValue = (id, text) =>
		onUpdate({ ...option, values: option.values.map((value) => (value.id === id ? { ...value, text } : value)) });

	return (
		<div className="border border-gray-200 rounded-lg p-3 space-y-3">
			<div className="flex items-center gap-2">
				<input
					type="text"
					value={option.name}
					onChange={(e) => onUpdate({ ...option, name: e.target.value })}
					className="form-input h-9 py-1 text-sm"
					placeholder="Tên phân loại, vd Màu sắc"
					maxLength={OPTION_TEXT_MAX}
					aria-label={`Tên phân loại ${index + 1}`}
				/>
				<button type="button" className={SMALL_BUTTON} onClick={() => onMove(-1)} disabled={index === 0} aria-label="Đưa phân loại lên" title="Đưa lên">
					<i className="fa-solid fa-chevron-up"></i>
				</button>
				<button type="button" className={SMALL_BUTTON} onClick={() => onMove(1)} disabled={index === count - 1} aria-label="Đưa phân loại xuống" title="Đưa xuống">
					<i className="fa-solid fa-chevron-down"></i>
				</button>
				<button type="button" className={`${SMALL_BUTTON} text-danger-600`} onClick={onRemove} aria-label="Xóa phân loại" title="Xóa phân loại">
					<i className="fa-solid fa-trash"></i>
				</button>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				{option.values.map((value) => (
					<span key={value.id} className="inline-flex items-center h-9 rounded-full bg-primary-50 border border-primary-200 pl-3 pr-1">
						<input
							type="text"
							value={value.text}
							onChange={(e) => renameValue(value.id, e.target.value)}
							maxLength={OPTION_TEXT_MAX}
							size={Math.max(value.text.length, 3)}
							className="bg-transparent text-sm text-primary-800 focus:outline-none"
							aria-label="Giá trị phân loại"
						/>
						<button
							type="button"
							className="w-7 h-7 rounded-full text-primary-700 hover:bg-primary-100"
							onClick={() => onUpdate({ ...option, values: option.values.filter((v) => v.id !== value.id) })}
							aria-label={`Xóa giá trị ${value.text}`}
							title="Xóa giá trị"
						>
							<i className="fa-solid fa-xmark"></i>
						</button>
					</span>
				))}
				<input
					type="text"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							addValue();
						}
					}}
					onBlur={addValue}
					className="form-input h-9 py-1 text-sm w-48"
					placeholder="Nhập giá trị rồi nhấn Enter"
					maxLength={OPTION_TEXT_MAX}
					aria-label={`Thêm giá trị cho phân loại ${index + 1}`}
				/>
			</div>
		</div>
	);
};

const ProductOptionsField = ({ options, onChange, error }) => (
	<div>
		<div className="flex items-center justify-between mb-2">
			<span className="block text-sm font-medium text-gray-700">Phân loại (màu, size...)</span>
			<button
				type="button"
				className="btn-secondary h-9 py-0"
				onClick={() => onChange([...options, createOption()])}
			>
				<i className="fa-solid fa-plus mr-2"></i>
				Thêm phân loại
			</button>
		</div>
		{options.length === 0 ? (
			<p className="text-sm text-gray-500">Sản phẩm không có phân loại: chỉ một mức giá và một tồn kho.</p>
		) : (
			<div className="space-y-3">
				{options.map((option, index) => (
					<OptionCard
						key={option.id}
						option={option}
						index={index}
						count={options.length}
						onUpdate={(next) => onChange(options.map((entry) => (entry.id === option.id ? next : entry)))}
						onMove={(delta) => onChange(moveItem(options, index, delta))}
						onRemove={() => onChange(options.filter((entry) => entry.id !== option.id))}
					/>
				))}
			</div>
		)}
		{error && (
			<p role="alert" aria-invalid="true" tabIndex={-1} className="mt-1 text-sm text-danger-500">
				<i className="fas fa-exclamation-circle mr-1" aria-hidden="true"></i>
				{error}
			</p>
		)}
	</div>
);

export default ProductOptionsField;
