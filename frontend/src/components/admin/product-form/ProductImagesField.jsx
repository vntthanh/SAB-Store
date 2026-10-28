import React, { useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { MAX_PRODUCT_IMAGES, productVariantSetup } from '@sab/shared';
import LoadingSpinner from '../../LoadingSpinner';
import { MAX_IMAGE_SIDE, processImageFile, validateImageFile } from '../../../utils/imageUtils';
import { getImageUrl } from '../../../utils/helpers';
import { moveItem } from './variant-setup';

const ICON_BUTTON =
	'inline-flex items-center justify-center w-7 h-7 rounded bg-white/90 text-gray-700 shadow hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed';

// A file that fails is skipped with its own toast.
const prepareFile = async (file) => {
	const validation = validateImageFile(file);
	if (!validation.valid) {
		toast.error(`${file.name}: ${validation.error}`);
		return null;
	}
	try {
		return await processImageFile(file);
	} catch (error) {
		console.error('Image processing error:', error);
		toast.error(`${file.name}: lỗi khi xử lý hình ảnh (${error.message})`);
		return null;
	}
};

const ProductImagesField = ({ images, onChange, onUploadImages, onBusyChange, error, disabled = false }) => {
	const [busy, setBusy] = useState(false);
	const [urlDraft, setUrlDraft] = useState('');
	const fileInputRef = useRef(null);
	const slotsLeft = MAX_PRODUCT_IMAGES - images.length;
	const locked = busy || disabled;

	const setBusyState = (value) => {
		setBusy(value);
		if (onBusyChange) onBusyChange(value);
	};

	const handleFiles = async (event) => {
		const picked = Array.from(event.target.files || []);
		event.target.value = '';
		if (picked.length === 0) return;
		if (picked.length > slotsLeft) {
			toast.warn(`Chỉ còn chỗ cho ${slotsLeft} ảnh, các ảnh dư sẽ bị bỏ qua`);
		}
		setBusyState(true);
		try {
			const prepared = (await Promise.all(picked.slice(0, Math.max(slotsLeft, 0)).map(prepareFile))).filter(Boolean);
			if (prepared.length === 0) return;
			const result = await onUploadImages(prepared);
			const urls = (result?.images || []).map((image) => image.url).filter((url) => !images.includes(url));
			onChange([...images, ...urls]);
		} catch (uploadError) {
			console.error('Upload error:', uploadError);
			toast.error(uploadError.message || 'Lỗi khi upload hình ảnh');
		} finally {
			setBusyState(false);
		}
	};

	const handleAddUrl = () => {
		const url = urlDraft.trim();
		if (!url) return;
		if (images.includes(url)) {
			toast.warn('Ảnh này đã có trong danh sách');
			return;
		}
		if (slotsLeft <= 0) {
			toast.warn(`Tối đa ${MAX_PRODUCT_IMAGES} ảnh`);
			return;
		}
		const check = productVariantSetup.safeParse({ images: [url] });
		if (!check.success) {
			toast.error(check.error.issues[0].message);
			return;
		}
		onChange([...images, url]);
		setUrlDraft('');
	};

	return (
		<div>
			<div className="flex items-center justify-between mb-1">
				<span id="product-images-label" className="block text-sm font-medium text-gray-700">
					Hình ảnh sản phẩm
				</span>
				<span className="text-xs text-gray-500">{images.length}/{MAX_PRODUCT_IMAGES}</span>
			</div>
			<div className="text-xs text-blue-600 mb-2">
				<i className="fas fa-info-circle mr-1"></i>
				Ảnh được lưu nguyên khung, không bị cắt (khung xem trước có thể che bớt rìa; trên trang bán hàng bấm vào ảnh để xem đầy đủ). Ảnh lớn được thu nhỏ còn cạnh dài tối đa {MAX_IMAGE_SIDE}px.
			</div>

			{images.length > 0 && (
				<ul className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 mb-3">
					{images.map((url, index) => (
						<li key={url} className="relative">
							<img
								src={getImageUrl(url)}
								alt={`Ảnh ${index + 1}`}
								className="w-full object-cover rounded-lg border"
								style={{ aspectRatio: '1.5/1' }}
								onError={(e) => {
									e.target.src = '/fallback-product.png';
								}}
							/>
							{index === 0 && (
								<span className="absolute left-1 top-1 badge badge-primary">Ảnh bìa</span>
							)}
							<div className="absolute right-1 top-1">
								<button
									type="button"
									className={`${ICON_BUTTON} text-danger-600`}
									onClick={() => onChange(images.filter((_, i) => i !== index))}
									disabled={locked}
									aria-label={`Xóa ảnh ${index + 1}`}
									title="Xóa ảnh"
								>
									<i className="fa-solid fa-xmark"></i>
								</button>
							</div>
							<div className="absolute left-1 bottom-1 flex gap-1">
								<button
									type="button"
									className={ICON_BUTTON}
									onClick={() => onChange(moveItem(images, index, -1))}
									disabled={locked || index === 0}
									aria-label={`Chuyển ảnh ${index + 1} sang trái`}
									title="Chuyển sang trái"
								>
									<i className="fa-solid fa-chevron-left"></i>
								</button>
								<button
									type="button"
									className={ICON_BUTTON}
									onClick={() => onChange(moveItem(images, index, 1))}
									disabled={locked || index === images.length - 1}
									aria-label={`Chuyển ảnh ${index + 1} sang phải`}
									title="Chuyển sang phải"
								>
									<i className="fa-solid fa-chevron-right"></i>
								</button>
							</div>
						</li>
					))}
				</ul>
			)}

			<div className="flex flex-col sm:flex-row sm:items-center gap-2">
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					multiple
					className="hidden"
					onChange={handleFiles}
					disabled={locked || slotsLeft <= 0}
				/>
				<button
					type="button"
					className="btn-secondary h-10 py-0"
					onClick={() => fileInputRef.current?.click()}
					disabled={locked || slotsLeft <= 0}
				>
					<i className="fa-solid fa-upload mr-2"></i>
					Tải ảnh lên
				</button>
				<div className="flex flex-1 items-center gap-2">
					<input
						type="text"
						value={urlDraft}
						onChange={(e) => setUrlDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								handleAddUrl();
							}
						}}
						className="form-input h-10 py-0"
						placeholder="Hoặc dán URL ảnh https://..."
						aria-labelledby="product-images-label"
						disabled={locked || slotsLeft <= 0}
					/>
					<button
						type="button"
						className="btn-secondary h-10 py-0 whitespace-nowrap"
						onClick={handleAddUrl}
						disabled={locked || slotsLeft <= 0 || !urlDraft.trim()}
					>
						Thêm URL
					</button>
				</div>
			</div>

			{busy && (
				<div className="mt-2 text-sm text-blue-600 flex items-center">
					<LoadingSpinner size="small" />
					<span className="ml-2">Đang xử lý và upload ảnh...</span>
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
};

export default ProductImagesField;
