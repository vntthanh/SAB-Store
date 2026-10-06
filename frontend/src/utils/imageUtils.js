/**
 * Image utility functions for product image processing
 * Standard ratio based on fallback-product.png: 1.5009:1 (width:height)
 */

// Standard ratio for product images (width / height) - matches fallback-product.png (800x533)
const PRODUCT_IMAGE_RATIO = 1.50093808630394;

/**
 * Get image dimensions from file or URL
 * @param {File|string} source - Image file or URL
 * @returns {Promise<{width: number, height: number}>}
 */
export const getImageDimensions = (source) => {
	return new Promise((resolve, reject) => {
		const img = new Image();

		img.onload = () => {
			resolve({
				width: img.naturalWidth,
				height: img.naturalHeight
			});
		};

		img.onerror = () => {
			reject(new Error('Failed to load image'));
		};

		if (source instanceof File) {
			img.src = URL.createObjectURL(source);
		} else {
			img.src = source;
		}
	});
};

/**
 * Resize and crop image to standard ratio
 * @param {File} file - Image file to process
 * @param {number} maxWidth - Maximum width (default: 800px)
 * @param {number} quality - JPEG quality (0-1, default: 0.9)
 * @returns {Promise<{file: File, preview: string}>}
 */
export const processImageFile = async (file, maxWidth = 800, quality = 0.9) => {
	return new Promise((resolve, reject) => {
		const img = new Image();

		img.onload = () => {
			try {
				const canvas = document.createElement('canvas');
				const ctx = canvas.getContext('2d');

				// Calculate dimensions for standard ratio
				const originalWidth = img.naturalWidth;
				const originalHeight = img.naturalHeight;
				const originalRatio = originalWidth / originalHeight;

				let sourceX = 0;
				let sourceY = 0;
				let sourceWidth = originalWidth;
				let sourceHeight = originalHeight;

				// Crop to standard ratio (center crop)
				if (originalRatio > PRODUCT_IMAGE_RATIO) {
					// Image is wider than standard ratio - crop width
					sourceWidth = originalHeight * PRODUCT_IMAGE_RATIO;
					sourceX = (originalWidth - sourceWidth) / 2;
				} else if (originalRatio < PRODUCT_IMAGE_RATIO) {
					// Image is taller than standard ratio - crop height
					sourceHeight = originalWidth / PRODUCT_IMAGE_RATIO;
					sourceY = (originalHeight - sourceHeight) / 2;
				}

				// Calculate output dimensions
				const outputWidth = Math.min(maxWidth, sourceWidth);
				const outputHeight = outputWidth / PRODUCT_IMAGE_RATIO;

				// Set canvas size
				canvas.width = outputWidth;
				canvas.height = outputHeight;

				// Draw cropped and resized image
				ctx.drawImage(
					img,
					sourceX, sourceY, sourceWidth, sourceHeight,
					0, 0, outputWidth, outputHeight
				);

				// Convert to blob
				canvas.toBlob(
					(blob) => {
						if (!blob) {
							reject(new Error('Failed to process image'));
							return;
						}

						// Create new file with processed image
						const processedFile = new File(
							[blob],
							file.name,
							{ type: file.type, lastModified: Date.now() }
						);

						// Create preview URL
						const previewUrl = canvas.toDataURL('image/jpeg', quality);

						resolve({
							file: processedFile,
							preview: previewUrl
						});
					},
					file.type.startsWith('image/jpeg') ? 'image/jpeg' : 'image/png',
					quality
				);

			} catch (error) {
				reject(error);
			}
		};

		img.onerror = () => {
			reject(new Error('Failed to load image for processing'));
		};

		img.src = URL.createObjectURL(file);
	});
};

/**
 * Format file size for display
 * @param {number} bytes 
 * @returns {string}
 */
const formatFileSize = (bytes) => {
	if (bytes === 0) return '0 Bytes';

	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Validate image file
 * @param {File} file 
 * @returns {{valid: boolean, error?: string}}
 */
export const validateImageFile = (file) => {
	const maxSize = 200 * 1024 * 1024; // 200MB
	const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

	if (!allowedTypes.includes(file.type)) {
		return {
			valid: false,
			error: 'Chỉ cho phép upload file hình ảnh (JPG, JPEG, PNG, GIF, WEBP)'
		};
	}

	if (file.size > maxSize) {
		return {
			valid: false,
			error: `Kích thước file không được vượt quá ${formatFileSize(maxSize)}`
		};
	}

	return { valid: true };
};

/**
 * Get ratio info text for display
 * @returns {string}
 */
export const getRatioDisplayText = () => {
	return `Tỉ lệ chuẩn: 1.5:1 (rộng:cao) - 800x533px`;
};

/**
 * Check if image needs cropping
 * @param {number} width 
 * @param {number} height 
 * @returns {boolean}
 */
export const needsCropping = (width, height) => {
	const currentRatio = width / height;
	const tolerance = 0.01; // 1% tolerance
	return Math.abs(currentRatio - PRODUCT_IMAGE_RATIO) > tolerance;
};
