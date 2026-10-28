import React, { useState } from 'react';
import { getImageUrl } from '../../../utils/helpers';
import { NO_IMAGE } from './variant-setup';

// One height for every control of the grid and its bulk bar.
const CELL = 'form-input h-9 py-1 text-sm';

const Thumb = ({ url }) =>
	url ? (
		<img src={getImageUrl(url)} alt="" className="w-9 h-9 rounded border object-cover shrink-0" />
	) : (
		<span className="w-9 h-9 rounded border border-dashed border-gray-300 shrink-0" aria-hidden="true"></span>
	);

const ImageSelect = ({ value, images, onChange, emptyLabel, label, withClear = false }) => (
	<div className="flex items-center gap-2">
		<Thumb url={value && value !== NO_IMAGE ? value : ''} />
		<select value={value} onChange={(e) => onChange(e.target.value)} className={CELL} aria-label={label}>
			<option value="">{emptyLabel}</option>
			{withClear && <option value={NO_IMAGE}>Không có ảnh</option>}
			{images.map((url, index) => (
				<option key={url} value={url}>Ảnh {index + 1}{index === 0 ? ' (bìa)' : ''}</option>
			))}
		</select>
	</div>
);

const BulkBar = ({ options, images, onApply }) => {
	const [target, setTarget] = useState('');
	const [price, setPrice] = useState('');
	const [imageUrl, setImageUrl] = useState('');
	const canApply = price.trim() !== '' || imageUrl !== '';

	return (
		<div className="flex flex-wrap items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg p-2">
			<select value={target} onChange={(e) => setTarget(e.target.value)} className={`${CELL} w-auto`} aria-label="Áp dụng cho">
				<option value="">Tất cả phân loại</option>
				{options.flatMap((option) =>
					option.values.map((value) => (
						<option key={value.id} value={value.id}>
							Tất cả {option.name.trim() || 'phân loại'}: {value.text.trim() || '(trống)'}
						</option>
					))
				)}
			</select>
			<input
				type="number"
				min="0"
				step="1000"
				value={price}
				onChange={(e) => setPrice(e.target.value)}
				className={`${CELL} w-32`}
				placeholder="Giá"
				aria-label="Giá áp dụng hàng loạt"
			/>
			<ImageSelect value={imageUrl} images={images} onChange={setImageUrl} emptyLabel="Giữ ảnh" withClear label="Ảnh áp dụng hàng loạt" />
			<button
				type="button"
				className="btn-secondary h-9 py-0"
				disabled={!canApply}
				onClick={() => {
					onApply({ valueId: target, price, imageUrl });
					setPrice('');
					setImageUrl('');
				}}
			>
				Áp dụng
			</button>
		</div>
	);
};

const ArchivedVariants = ({ variants }) => (
	<details className="border border-gray-200 rounded-lg">
		<summary className="cursor-pointer px-3 py-2 text-sm text-gray-600">
			Đã lưu trữ ({variants.length})
		</summary>
		<div className="overflow-x-auto">
			<table className="min-w-full text-sm text-gray-500">
				<thead>
					<tr className="text-left text-xs uppercase">
						<th className="px-3 py-1">Phân loại</th>
						<th className="px-3 py-1">Giá</th>
						<th className="px-3 py-1">SKU</th>
						<th className="px-3 py-1">Tồn</th>
					</tr>
				</thead>
				<tbody>
					{variants.map((variant) => (
						<tr key={variant._id} className="bg-gray-50">
							<td className="px-3 py-1">{variant.label || variant.optionValues.join(' / ')}</td>
							<td className="px-3 py-1">{variant.price ?? '—'}</td>
							<td className="px-3 py-1">{variant.sku || '—'}</td>
							<td className="px-3 py-1">{variant.stockQuantity ?? 0}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
		<p className="px-3 py-2 text-xs text-gray-500">
			Thêm lại đúng tổ hợp này vào phân loại để khôi phục cùng tồn kho.
		</p>
	</details>
);

const ProductVariantsGrid = ({ rows, options, images, productPrice, creating, onInput, onBulk, rowErrors, error, archived }) => (
	<div className="space-y-3">
		<div className="flex items-center justify-between">
			<span className="block text-sm font-medium text-gray-700">Tổ hợp phân loại ({rows.length})</span>
		</div>

		{rows.length > 0 && <BulkBar options={options} images={images} onApply={onBulk} />}

		{rows.length === 0 ? (
			<p className="text-sm text-gray-500">Mỗi phân loại cần ít nhất một giá trị để tạo tổ hợp.</p>
		) : (
			<div className="overflow-x-auto border border-gray-200 rounded-lg">
				<table className="min-w-[760px] w-full text-sm">
					<thead className="bg-gray-50">
						<tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
							<th className="px-3 py-2">Phân loại</th>
							<th className="px-3 py-2">Giá (VND)</th>
							<th className="px-3 py-2">SKU</th>
							<th className="px-3 py-2">Ảnh</th>
							<th className="px-3 py-2">{creating ? 'Tồn ban đầu' : 'Tồn kho'}</th>
							<th className="px-3 py-2">Đang bán</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-gray-200">
						{rows.map((row, index) => {
							const rowError = rowErrors[index];
							return (
								<tr key={row.key} className={row.input.isActive ? '' : 'bg-gray-50'}>
									<td className="px-3 py-2 whitespace-nowrap font-medium text-gray-900">
										{row.label}
										{rowError && (
											<p role="alert" className="text-xs font-normal text-danger-500 whitespace-normal max-w-[14rem]">{rowError}</p>
										)}
									</td>
									<td className="px-3 py-2">
										<input
											type="number"
											min="0"
											step="1000"
											value={row.input.price}
											onChange={(e) => onInput(row.key, { price: e.target.value })}
											className={`${CELL} w-32`}
											placeholder={productPrice === '' ? 'Giá sản phẩm' : String(productPrice)}
											aria-label={`Giá ${row.label}`}
											aria-invalid={rowError ? 'true' : undefined}
										/>
									</td>
									<td className="px-3 py-2">
										<input
											type="text"
											value={row.input.sku}
											onChange={(e) => onInput(row.key, { sku: e.target.value })}
											className={`${CELL} w-36`}
											maxLength={64}
											aria-label={`SKU ${row.label}`}
										/>
									</td>
									<td className="px-3 py-2">
										<ImageSelect
											value={row.input.imageUrl}
											images={images}
											onChange={(url) => onInput(row.key, { imageUrl: url })}
											emptyLabel="Không có"
											label={`Ảnh ${row.label}`}
										/>
									</td>
									<td className="px-3 py-2">
										{creating ? (
											<input
												type="number"
												min="0"
												step="1"
												value={row.input.openingStock}
												onChange={(e) => onInput(row.key, { openingStock: e.target.value })}
												className={`${CELL} w-24`}
												placeholder="0"
												aria-label={`Tồn ban đầu ${row.label}`}
											/>
										) : (
											<span className="text-gray-700">{row.input.stockQuantity ?? '—'}</span>
										)}
									</td>
									<td className="px-3 py-2">
										<input
											type="checkbox"
											checked={row.input.isActive}
											onChange={(e) => onInput(row.key, { isActive: e.target.checked })}
											className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
											aria-label={`Đang bán ${row.label}`}
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		)}

		{error && (
			<p role="alert" aria-invalid="true" tabIndex={-1} className="text-sm text-danger-500">
				<i className="fas fa-exclamation-circle mr-1" aria-hidden="true"></i>
				{error}
			</p>
		)}

		{archived.length > 0 && <ArchivedVariants variants={archived} />}
	</div>
);

export default ProductVariantsGrid;
