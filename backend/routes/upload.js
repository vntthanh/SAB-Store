const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { uploadFile, deleteFile } = require('../lib/minio');
const { validateImageFile, generateSecureFilename, sanitizeFilename, MAX_FILE_SIZE } = require('../utils/fileValidator');
const ErrorLogger = require('../utils/errorLogger');
const router = express.Router();

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
	const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

	if (!allowedMimeTypes.includes(file.mimetype)) {
		return cb(new Error('Chỉ chấp nhận file ảnh (JPEG, PNG, GIF, WebP)'));
	}

	cb(null, true);
};

const upload = multer({
	storage: storage,
	limits: {
		fileSize: MAX_FILE_SIZE
	},
	fileFilter: fileFilter
});

// Errors that are safe to show verbatim: they describe what is wrong with
// the *file the caller just sent*, not an internal (MinIO, filesystem) detail.
const isClientFacingUploadError = (message) =>
	message.includes('File signature') ||
	message.includes('Invalid') ||
	message.includes('exceeds') ||
	message.includes('Filename validation');

// A correlation id lets ops find the full error (with stack) in the server
// log for a report like "upload failed just now" without ever putting the
// raw internal message (MinIO connection details, stack fragments, etc.) in
// the client-facing response.
function sendUploadServerError(res, routeName, error, req, fallbackMessage) {
	const correlationId = crypto.randomUUID();
	ErrorLogger.logRoute(routeName, error, req);
	console.error(`[UPLOAD ${correlationId}]`, routeName, error);

	res.status(500).json({
		success: false,
		message: fallbackMessage,
		correlationId
	});
}

router.post('/product-image', upload.single('image'), async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).json({
				success: false,
				message: 'Không có file nào được tải lên'
			});
		}

		await validateImageFile(req.file);

		const filename = generateSecureFilename(req.file.originalname);
		const objectName = `products/${filename}`;

		await uploadFile(objectName, req.file.buffer, req.file.mimetype);

		const imageUrl = `/uploads/${objectName}`;

		res.json({
			success: true,
			message: 'Tải ảnh thành công',
			imageUrl: imageUrl,
			filename: filename
		});
	} catch (error) {
		if (isClientFacingUploadError(error.message)) {
			ErrorLogger.logRoute('POST /upload/product-image', error, req);
			return res.status(400).json({
				success: false,
				message: error.message
			});
		}

		sendUploadServerError(res, 'POST /upload/product-image', error, req, 'Lỗi server khi tải ảnh');
	}
});

router.post('/product-images', upload.array('images', 5), async (req, res) => {
	try {
		if (!req.files || req.files.length === 0) {
			return res.status(400).json({
				success: false,
				message: 'Không có file nào được tải lên'
			});
		}

		for (const file of req.files) {
			await validateImageFile(file);
		}

		const imageUrls = [];

		for (const file of req.files) {
			const filename = generateSecureFilename(file.originalname);
			const objectName = `products/${filename}`;

			await uploadFile(objectName, file.buffer, file.mimetype);

			imageUrls.push({
				url: `/uploads/${objectName}`,
				filename: filename
			});
		}

		res.json({
			success: true,
			message: `Tải ${req.files.length} ảnh thành công`,
			images: imageUrls
		});
	} catch (error) {
		if (isClientFacingUploadError(error.message)) {
			ErrorLogger.logRoute('POST /upload/product-images', error, req);
			return res.status(400).json({
				success: false,
				message: error.message
			});
		}

		sendUploadServerError(res, 'POST /upload/product-images', error, req, 'Lỗi server khi tải ảnh');
	}
});

router.delete('/product-image/:filename', async (req, res) => {
	try {
		const filename = sanitizeFilename(req.params.filename);
		const objectName = `products/${filename}`;

		await deleteFile(objectName);

		res.json({
			success: true,
			message: 'Xóa ảnh thành công'
		});
	} catch (error) {
		if (error.message.includes('Invalid filename')) {
			ErrorLogger.logRoute('DELETE /upload/product-image/:filename', error, req);
			return res.status(400).json({
				success: false,
				message: 'Tên file không hợp lệ'
			});
		}

		if (error.code === 'NotFound') {
			ErrorLogger.logRoute('DELETE /upload/product-image/:filename', error, req);
			return res.status(404).json({
				success: false,
				message: 'Không tìm thấy file'
			});
		}

		sendUploadServerError(res, 'DELETE /upload/product-image/:filename', error, req, 'Lỗi server khi xóa ảnh');
	}
});

// Multer throws its own errors (LIMIT_FILE_SIZE, LIMIT_FILE_COUNT, ...) from
// the upload.single/array middleware itself, before a route handler's own
// try/catch ever runs — uncaught, those fell through to Express's default
// handler as a 500. Mounted last so it only sees errors from the routes above.
router.use((err, req, res, next) => {
	if (err instanceof multer.MulterError) {
		const messages = {
			LIMIT_FILE_SIZE: `Kích thước file vượt quá giới hạn ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
			LIMIT_FILE_COUNT: 'Vượt quá số lượng file cho phép (tối đa 5 ảnh)',
			LIMIT_UNEXPECTED_FILE: 'Trường file không hợp lệ'
		};

		return res.status(400).json({
			success: false,
			message: messages[err.code] || `Lỗi tải file: ${err.code}`
		});
	}

	// fileFilter's rejection reaches here as a plain Error, not a MulterError.
	if (err && err.message && err.message.includes('Chỉ chấp nhận file ảnh')) {
		return res.status(400).json({
			success: false,
			message: err.message
		});
	}

	next(err);
});

module.exports = router;
