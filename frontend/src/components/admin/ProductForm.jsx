import React, { useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { SALES_CHANNELS, SALES_CHANNEL_LABELS, normalizeSalesChannel } from '../../utils/sales-channel';
import useFieldErrors from '../../hooks/use-field-errors';
import FormField from '../form/FormField';
import ProductImagesField from './product-form/ProductImagesField';
import ProductOptionsField from './product-form/ProductOptionsField';
import ProductVariantsGrid from './product-form/ProductVariantsGrid';
import {
	archivedVariantsOf,
	applyBulk,
	buildSetup,
	exceedsCombinationLimit,
	gridRows,
	groupIssues,
	inputsFromProduct,
	remapInputs,
	optionsFromProduct,
	releaseImage,
	setRowInput,
	validateSetup
} from './product-form/variant-setup';

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
	description: (value) => (value.length > 500 ? 'Mô tả không được vượt quá 500 ký tự' : null),
	storefrontId: (value) => (value ? null : 'Gian hàng là bắt buộc')
};

const FALLBACK_IMAGE = '/fallback-product.png';

// Records saved before galleries only have the cover in imageUrl.
const initialImages = (product) => {
	if (Array.isArray(product?.images) && product.images.length > 0) return product.images;
	return product?.imageUrl && product.imageUrl !== FALLBACK_IMAGE ? [product.imageUrl] : [];
};

const ProductForm = ({
	product,
	onSubmit,
	onCancel,
	onUploadImages,
	storefronts = [],
	defaultStorefrontId = ''
}) => {
	const [formData, setFormData] = useState({
		name: product?.name || '',
		description: product?.description || '',
		price: product?.price?.toString() || '',
		category: product?.category || '',
		available: product?.available ?? true,
		salesChannel: normalizeSalesChannel(product?.salesChannel),
		storefrontId: product?.storefrontId || defaultStorefrontId,
		stockQuantity: ''
	});
	const [images, setImages] = useState(() => initialImages(product));
	// Row inputs are keyed by the ids of the option values, so both come from one load.
	const [seed] = useState(() => {
		const seededOptions = optionsFromProduct(product);
		return { options: seededOptions, inputs: inputsFromProduct(product, seededOptions) };
	});
	const [options, setOptions] = useState(seed.options);
	const [inputs, setInputs] = useState(seed.inputs);
	const [uploading, setUploading] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [attempted, setAttempted] = useState(false);
	const { errors, validateField, onFieldChange, validateAll, focusFirstError } = useFieldErrors(PRODUCT_RULES);
	const formRef = useRef(null);

	const creating = !product;
	// A product saved without options keeps the old request shape until the admin adds some.
	const hadOptions = (product?.options?.length ?? 0) > 0;
	const hasOptions = options.length > 0;
	const sendSetup = hasOptions || hadOptions;
	const tooMany = exceedsCombinationLimit(options);

	const rows = useMemo(() => (tooMany ? [] : gridRows(options, inputs)), [options, inputs, tooMany]);
	const setup = useMemo(
		() => (sendSetup ? { images, ...buildSetup({ options, inputs, creating }) } : { images }),
		[sendSetup, images, options, inputs, creating]
	);
	const { parts, rows: rowErrors } = useMemo(() => groupIssues(validateSetup(setup)), [setup]);
	const showSetupErrors = attempted || tooMany;

	const handleInputChange = (e) => {
		const { name, value, type, checked } = e.target;
		setFormData(prev => ({
			...prev,
			[name]: type === 'checkbox' ? checked : value
		}));
		if (type !== 'checkbox' && type !== 'radio') {
			onFieldChange(name, value, { ...formData, [name]: value });
		}
	};

	const handleImagesChange = (next) => {
		const removed = images.filter((url) => !next.includes(url));
		if (removed.length > 0) {
			let nextInputs = inputs;
			let released = 0;
			removed.forEach((url) => {
				const result = releaseImage(nextInputs, url);
				nextInputs = result.inputs;
				released += result.released;
			});
			if (released > 0) {
				setInputs(nextInputs);
				toast.info(`${released} phân loại đang dùng ảnh vừa xóa đã được bỏ ảnh`);
			}
		}
		setImages(next);
	};

	const handleBlur = (e) => {
		validateField(e.target.name, e.target.value, formData);
	};

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (submitting || uploading) return;
		setAttempted(true);
		// Stock is not sent for an existing product, or for one with options (each variant has its own), so its rule must not block saving.
		const values = !creating || hasOptions ? { ...formData, stockQuantity: '' } : formData;
		const fieldsOk = validateAll(values);
		const setupOk = Object.keys(parts).length === 0 && Object.keys(rowErrors).length === 0;
		if (!fieldsOk || !setupOk) {
			focusFirstError(formRef);
			return;
		}
		setSubmitting(true);
		try {
			const { stockQuantity, ...fields } = formData;
			const productData = { ...fields, price: parseFloat(formData.price), ...setup };
			// Existing products change stock only through ledger adjustments.
			if (creating && !hasOptions) {
				productData.stockQuantity = parseInt(stockQuantity, 10) || 0;
			}

			await onSubmit(productData);
		} catch (error) {
			console.error('Error saving product:', error);
			toast.error(error.message || 'Lỗi khi lưu sản phẩm');
		} finally {
			setSubmitting(false);
		}
	};

	const busy = submitting || uploading;

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

				<FormField id="product-storefrontId" label="Gian hàng" required error={errors.storefrontId}>
					<select
						name="storefrontId"
						value={formData.storefrontId}
						onChange={handleInputChange}
						onBlur={handleBlur}
						className="form-input"
					>
						<option value="">Chọn gian hàng</option>
						{storefronts.map((storefront) => (
							<option key={storefront._id} value={storefront._id}>{storefront.name}</option>
						))}
					</select>
				</FormField>

				<FormField
					id="product-price"
					label="Giá (VND)"
					required
					error={errors.price}
					hint={hasOptions ? 'Giá mặc định của các phân loại không nhập giá riêng' : undefined}
				>
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

				{creating && !hasOptions && (
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

			<ProductImagesField
				images={images}
				onChange={handleImagesChange}
				onUploadImages={onUploadImages}
				onBusyChange={setUploading}
				disabled={submitting}
				error={showSetupErrors ? parts.images : undefined}
			/>

			<ProductOptionsField
				options={options}
				onChange={(nextOptions) => {
					setInputs((current) => remapInputs(options, nextOptions, current));
					setOptions(nextOptions);
				}}
				error={showSetupErrors ? parts.options : undefined}
			/>

			{hasOptions && (
				<ProductVariantsGrid
					rows={rows}
					options={options}
					images={images}
					productPrice={formData.price}
					creating={creating}
					onInput={(key, patch) => setInputs((prev) => setRowInput(prev, key, patch))}
					onBulk={(bulk) => setInputs((prev) => applyBulk(prev, rows, bulk))}
					rowErrors={showSetupErrors ? rowErrors : {}}
					error={showSetupErrors ? parts.variants : undefined}
					archived={archivedVariantsOf(product)}
				/>
			)}

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
				<button type="submit" className="btn-primary" disabled={busy}>
					{submitting ? 'Đang lưu...' : uploading ? 'Đang upload ảnh...' : product ? 'Cập nhật' : 'Thêm mới'}
				</button>
			</div>
		</form>
	);
};

export default ProductForm;
