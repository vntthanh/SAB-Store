/**
 * Image utility functions for product image processing.
 *
 * Uploads are only scaled down, never cropped: a size chart or a landscape photo must reach the
 * shop whole. Every product view frames images with `object-cover`, so files of mixed ratios still
 * line up, and the fullscreen viewer shows the whole file.
 */

// Longest side after scaling: large enough that text in a size chart stays readable when zoomed.
export const MAX_IMAGE_SIDE = 1600;

// The upload route refuses files over 10MB. A lossless PNG of a photo can pass that at 1600px, so a
// PNG this large is re-encoded as JPEG; charts and drawings stay PNG and keep their text sharp.
const PNG_LIMIT_BYTES = 8 * 1024 * 1024;

const toBlob = (canvas, type, quality) =>
	new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Failed to process image'))), type, quality);
	});

// The backend checks the extension against the bytes, so the name must follow the encoded type.
const renamed = (name, type) => `${name.replace(/\.[^.]+$/, '')}.${type === 'image/jpeg' ? 'jpg' : 'png'}`;

const encode = async (canvas, file, quality) => {
	let type = file.type.startsWith('image/jpeg') ? 'image/jpeg' : 'image/png';
	let blob = await toBlob(canvas, type, quality);
	if (type === 'image/png' && blob.size > PNG_LIMIT_BYTES) {
		type = 'image/jpeg';
		blob = await toBlob(canvas, type, quality);
	}
	return new File([blob], renamed(file.name, type), { type, lastModified: Date.now() });
};

/**
 * Scale an image down so its longest side is at most `maxSide`, keeping its aspect ratio.
 * A file already within the limit is returned untouched: re-encoding it would only lose quality.
 * @param {File} file
 * @param {number} maxSide - Maximum width or height in pixels
 * @param {number} quality - JPEG quality (0-1)
 * @returns {Promise<File>}
 */
export const processImageFile = async (file, maxSide = MAX_IMAGE_SIDE, quality = 0.9) => {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const url = URL.createObjectURL(file);

		img.onload = () => {
			URL.revokeObjectURL(url);
			try {
				const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
				if (scale === 1) {
					resolve(file);
					return;
				}
				const canvas = document.createElement('canvas');
				canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
				canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
				canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

				encode(canvas, file, quality).then(resolve, reject);
			} catch (error) {
				reject(error);
			}
		};

		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('Failed to load image for processing'));
		};

		img.src = url;
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
