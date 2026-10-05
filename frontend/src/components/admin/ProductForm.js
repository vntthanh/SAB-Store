import React, { useRef, useState } from 'react';
import { toast } from 'react-toastify';
import LoadingSpinner from '../LoadingSpinner';
import {
	processImageFile,
	validateImageFile,
	getRatioDisplayText,
	getImageDimensions,
	needsCropping
} from '../../utils/imageUtils';
import { getImageUrl } from '../../utils/helpers';
import { SALES_CHANNELS, SALES_CHANNEL_LABELS, normalizeSalesChannel } from '../../utils/sales-channel';
import useFieldErrors from '../../hooks/use-field-errors';
import FormField from '../form/FormField';

// Client rules mirror the Product schema and POST /api/admin/products (the server stays authoritative).
const PRODUCT_RULES = {
	name: (value) => {
		const v = value.trim();
		if (!v) return 'Tên sản phẩm là bắt buộc';
		return v.length > 100 ? 'Tên sản phẩm không được vượt quá 100 ký tự' : null;
	},
	category: (value) => (value.trim() ? null : 'Danh mục sản phẩm là bắt buộc'),
	price: (value) => {
		if (String(value).trim() === '') return 'Giá sản phẩm là bắt buộc';
		const n = Number(value);
		if (!Number.isFinite(n) || n < 0) return 'Giá không được âm';
		return Number.isInteger(n) ? null : 'Giá phải là số nguyên (VND)';
	},
	stockQuantity: (value) => {
		if (String(value).trim() === '') return null;
		const n = Number(value);
		return Number.isInteger(n) && n >= 0 ? null : 'Số lượng tồn kho không hợp lệ';
	},
	description: (value) => (value.length > 500 ? 'Mô tả không được vượt quá 500 ký tự' : null)
};

const ProductForm = ({
	product,
	onSubmit,
	onCancel,
	onUploadImage
}) => {
	const [formData, setFormData] = useState({
		name: product?.name || '',
		description: product?.description || '',
		price: product?.price?.toString() || '',
		imageUrl: product?.imageUrl || '',
		category: product?.category || '',
		available: product?.available ?? true,
		salesChannel: normalizeSalesChannel(product?.salesChannel),
		stockQuantity: ''
	});

	const [imageFile, setImageFile] = useState(null);
	const [imagePreview, setImagePreview] = useState(
		product?.imageUrl ? getImageUrl(product.imageUrl) : null
	);
	const [uploadMethod, setUploadMethod] = useState(() => {
		if (!product?.imageUrl) return 'url';
		if (product.imageUrl.includes('/uploads/')) return 'path';
		if (product.imageUrl.startsWith('http')) return 'url';
		return 'path';
	});
	const [uploading, setUploading] = useState(false);
	const [processingImage, setProcessingImage] = useState(false);
	const [imageInfo, setImageInfo] = useState(null);
	const [submitting, setSubmitting] = useState(false);
	const { errors, validateField, onFieldChange, validateAll, focusFirstError } = useFieldErrors(PRODUCT_RULES);
	const formRef = useRef(null);

	const handleInputChange = (e) => {
		const { name, value, type, checked } = e.target;
		setFormData(prev => ({
			...prev,
			[name]: type === 'checkbox' ? checked : value
		}));
		if (type !== 'checkbox' && type !== 'radio') {
			onFieldChange(name, value, { ...formData, [name]: value });
		}

		// Update preview when imageUrl changes in URL mode
		if (name === 'imageUrl' && (uploadMethod === 'url' || uploadMethod === 'path')) {
			setImagePreview(getImageUrl(value) || null);
		}
	};

	const handleUploadMethodChange = (newMethod) => {
		setUploadMethod(newMethod);

		// Clear file-related states when switching away from upload
		if (newMethod !== 'upload') {
			setImageFile(null);
			setImageInfo(null);
			setProcessingImage(false);
			setUploading(false);
		}

		// Clear preview when switching methods
		if (newMethod === 'upload') {
			setImagePreview(null);
		} else if (newMethod === 'url' && formData.imageUrl) {
			setImagePreview(getImageUrl(formData.imageUrl));
		} else if (newMethod === 'path' && formData.imageUrl) {
			setImagePreview(getImageUrl(formData.imageUrl));
		}
	};

	const handleImageFileChange = async (e) => {
		const file = e.target.files[0];
		if (!file) return;

		// Validate file
		const validation = validateImageFile(file);
		if (!validation.valid) {
			toast.error(validation.error);
			return;
		}

		try {
			setProcessingImage(true);

			// Get original dimensions
			const dimensions = await getImageDimensions(file);

			// Check if cropping is needed
			const cropNeeded = needsCropping(dimensions.width, dimensions.height);

			setImageInfo({
				original: dimensions,
				needsCrop: cropNeeded,
				size: file.size
			});

			// Process image (crop and resize)
			const processed = await processImageFile(file);

			setImageFile(processed.file);
			setImagePreview(processed.preview);

			if (cropNeeded) {
				toast.info('Hình ảnh đã được cắt theo tỉ lệ chuẩn 1.5:1');
			}

		} catch (error) {
			console.error('Image processing error:', error);
			toast.error('Lỗi khi xử lý hình ảnh: ' + error.message);
		} finally {
			setProcessingImage(false);
		}
	};

	const uploadImageFile = async () => {
		if (!imageFile) return null;

		try {
			setUploading(true);
			const result = await onUploadImage(imageFile);

			if (result.success) {
				return result.imageUrl;
			} else {
				throw new Error(result.message || 'Upload failed');
			}
		} catch (error) {
			console.error('Upload error:', error);
			toast.error('Lỗi khi upload hình ảnh: ' + error.message);
			return null;
		} finally {
			setUploading(false);
		}
	};

	const handleBlur = (e) => {
		validateField(e.target.name, e.target.value, formData);
	};

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (submitting) return;
		// Stock is not sent for an existing product, so its rule must not block saving.
		const values = product ? { ...formData, stockQuantity: '' } : formData;
		if (!validateAll(values)) {
			focusFirstError(formRef);
			return;
		}
		setSubmitting(true);
		try {
			let finalImageUrl = formData.imageUrl;

			// Handle file upload if user selected a file
			if (uploadMethod === 'upload' && imageFile) {
				const uploadedUrl = await uploadImageFile();
				if (uploadedUrl) {
					finalImageUrl = uploadedUrl;
				} else {
					return; // Stop if upload failed
				}
			}

			const productData = {
				...formData,
				imageUrl: finalImageUrl,
				price: parseFloat(formData.price)
			};
			// Existing products change stock only through ledger adjustments.
			if (product) {
				delete productData.stockQuantity;
			} else {
				productData.stockQuantity = parseInt(formData.stockQuantity, 10) || 0;
			}

			await onSubmit(productData);
		} catch (error) {
			console.error('Error saving product:', error);
			toast.error('Lỗi khi lưu sản phẩm');
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form ref={formRef} onSubmit={handleSubmit} noValidate className="space-y-4">
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<FormField id="product-name" label="Tên sản phẩm" required error={errors.name}>
					<input
						type="text"
						name="name"
						value={formData.name}
						onChange={handleInputChange}
						onBlur={handleBlur}
						className="form-input"
						maxLength="100"
					/>
				</FormField>

				<FormField id="product-category" label="Danh mục" required error={errors.category}>
					<input
						type="text"
						name="category"
						value={formData.category}
						onChange={handleInputChange}
						onBlur={handleBlur}
						className="form-input"
					/>
				</FormField>

				<FormField id="product-price" label="Giá (VND)" required error={errors.price}>
					<input
						type="number"
						name="price"
						value={formData.price}
						onChange={handleInputChange}
						onBlur={handleBlur}
						className="form-input"
						min="0"
						step="1000"
					/>
				</FormField>

				{!product && (
					<FormField id="product-stockQuantity" label="Tồn ban đầu" error={errors.stockQuantity}>
						<input
							type="number"
							name="stockQuantity"
							value={formData.stockQuantity}
							onChange={handleInputChange}
							onBlur={handleBlur}
							className="form-input"
							min="0"
						/>
					</FormField>
				)}
			</div>

			<FormField id="product-description" label="Mô tả" error={errors.description}>
				<textarea
					name="description"
					value={formData.description}
					onChange={handleInputChange}
					onBlur={handleBlur}
					className="form-input"
					rows="3"
				/>
			</FormField>

			<div>
				<label className="block text-sm font-medium text-gray-700 mb-1">
					Hình ảnh sản phẩm
				</label>
				<div className="text-xs text-blue-600 mb-2">
					<i className="fas fa-info-circle mr-1"></i>
					{getRatioDisplayText()} - Hình ảnh sẽ được tự động cắt theo tỉ lệ này
				</div>

				{/* Upload method selector */}
				<div className="mb-3">
					<div className="flex space-x-4">
						<label className="inline-flex items-center">
							<input
								type="radio"
								className="form-radio"
								name="uploadMethod"
								value="url"
								checked={uploadMethod === 'url'}
								onChange={(e) => handleUploadMethodChange(e.target.value)}
							/>
							<span className="ml-2">URL</span>
						</label>
						<label className="inline-flex items-center">
							<input
								type="radio"
								className="form-radio"
								name="uploadMethod"
								value="upload"
								checked={uploadMethod === 'upload'}
								onChange={(e) => handleUploadMethodChange(e.target.value)}
							/>
							<span className="ml-2">Upload file</span>
						</label>
						<label className="inline-flex items-center">
							<input
								type="radio"
								className="form-radio"
								name="uploadMethod"
								value="path"
								checked={uploadMethod === 'path'}
								onChange={(e) => handleUploadMethodChange(e.target.value)}
							/>
							<span className="ml-2">File path</span>
						</label>
					</div>
				</div>

				{/* URL input */}
				{uploadMethod === 'url' && (
					<input
						type="text"
						name="imageUrl"
						value={formData.imageUrl}
						onChange={handleInputChange}
						className="form-input"
						placeholder="https://example.com/image.jpg"
					/>
				)}

				{/* File upload */}
				{uploadMethod === 'upload' && (
					<div>
						<input
							type="file"
							accept="image/*"
							onChange={handleImageFileChange}
							className="form-input"
							disabled={processingImage}
						/>

						{processingImage && (
							<div className="mt-2 text-sm text-blue-600">
								<LoadingSpinner size="small" />
								<span className="ml-2">Đang xử lý hình ảnh...</span>
							</div>
						)}

						{imageInfo && (
							<div className="mt-2 text-xs text-gray-600 bg-gray-50 p-2 rounded">
								<div>Kích thước gốc: {imageInfo.original.width}×{imageInfo.original.height}px</div>
								{imageInfo.needsCrop && (
									<div className="text-orange-600">
										<i className="fas fa-scissors mr-1"></i>
										Đã cắt theo tỉ lệ chuẩn
									</div>
								)}
							</div>
						)}

						{imagePreview && (
							<div className="mt-2">
								<img
									src={imagePreview}
									alt="Preview"
									className="w-32 h-21 object-cover rounded-lg border"
									style={{ aspectRatio: '1.5/1' }}
								/>
							</div>
						)}

						{uploading && (
							<div className="mt-2 text-sm text-blue-600">
								<LoadingSpinner size="small" />
								<span className="ml-2">Đang upload...</span>
							</div>
						)}
					</div>
				)}

				{/* File path input */}
				{uploadMethod === 'path' && (
					<input
						type="text"
						name="imageUrl"
						value={formData.imageUrl}
						onChange={handleInputChange}
						className="form-input"
						placeholder="/uploads/products/image.jpg"
					/>
				)}

				{/* Image preview for URL/path */}
				{(uploadMethod === 'url' || uploadMethod === 'path') && formData.imageUrl && (
					<div className="mt-2">
						<img
							src={getImageUrl(formData.imageUrl)}
							alt="Preview"
							className="w-32 h-21 object-cover rounded-lg border"
							style={{ aspectRatio: '1.5/1' }}
							onError={(e) => {
								e.target.src = '/fallback-product.png';
							}}
						/>
					</div>
				)}
			</div>

			<div className="flex items-center">
				<input
					type="checkbox"
					name="available"
					id="available"
					checked={formData.available}
					onChange={handleInputChange}
					className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
				/>
				<label htmlFor="available" className="ml-2 text-sm text-gray-700">
					Sản phẩm đang được bán
				</label>
			</div>

			<fieldset className={formData.available ? '' : 'opacity-50'}>
				<legend className="block text-sm font-medium text-gray-700 mb-1">Kênh bán</legend>
				<div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-x-6">
					{SALES_CHANNELS.map((channel) => (
						<label key={channel} className="inline-flex items-center min-h-[2rem] text-sm text-gray-700">
							<input
								type="radio"
								className="form-radio"
								name="salesChannel"
								value={channel}
								checked={formData.salesChannel === channel}
								onChange={handleInputChange}
							/>
							<span className="ml-2">{SALES_CHANNEL_LABELS[channel]}</span>
						</label>
					))}
				</div>
				{!formData.available && (
					<p className="text-xs text-gray-500 mt-1">Ngừng bán ở mọi kênh</p>
				)}
			</fieldset>

			<div className="flex justify-end space-x-3 pt-4">
				<button
					type="button"
					onClick={onCancel}
					className="btn-secondary"
				>
					Hủy
				</button>
				<button type="submit" className="btn-primary" disabled={submitting}>
					{submitting ? 'Đang lưu...' : product ? 'Cập nhật' : 'Thêm mới'}
				</button>
			</div>
		</form>
	);
};

export default ProductForm;
