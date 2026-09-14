const path = require('path');
const crypto = require('crypto');

const ALLOWED_IMAGE_TYPES = {
	'image/jpeg': {
		extensions: ['.jpg', '.jpeg'],
		signatures: [
			[0xFF, 0xD8, 0xFF, 0xDB],
			[0xFF, 0xD8, 0xFF, 0xE0],
			[0xFF, 0xD8, 0xFF, 0xE1],
			[0xFF, 0xD8, 0xFF, 0xEE]
		]
	},
	'image/png': {
		extensions: ['.png'],
		signatures: [
			[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
		]
	},
	'image/gif': {
		extensions: ['.gif'],
		signatures: [
			[0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
			[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
		]
	},
	'image/webp': {
		extensions: ['.webp'],
		signatures: [
			[0x52, 0x49, 0x46, 0x46]
		]
	}
};

// The frontend resizes images via canvas before upload, so a real product
// photo never approaches this. nginx caps /api/upload at 50MB independently.
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DANGEROUS_PATTERNS = [
	/\.\./,
	/[<>:"|?*\x00-\x1f]/,
	/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i,
	/\.exe$/i,
	/\.bat$/i,
	/\.cmd$/i,
	/\.sh$/i,
	/\.php$/i,
	/\.phtml$/i,
	/\.asp$/i,
	/\.aspx$/i,
	/\.jsp$/i,
	/\.js$/i,
	/\.html$/i,
	/\.htm$/i,
	/\.svg$/i
];

// WEBP's fourCC sits at byte offset 8-11, after the 4-byte "RIFF" tag and a
// 4-byte little-endian file-size field. RIFF alone is shared by AVI/WAV/other
// RIFF containers — checking only the first 4 bytes let any of those through
// as long as they were uploaded with a .webp filename.
const WEBP_FOURCC = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
const WEBP_FOURCC_OFFSET = 8;

function matchesSignature(buffer, signature, offset = 0) {
	for (let i = 0; i < signature.length; i++) {
		if (buffer[offset + i] !== signature[i]) {
			return false;
		}
	}
	return true;
}

function checkFileSignature(buffer, mimetype) {
	if (!ALLOWED_IMAGE_TYPES[mimetype]) {
		return false;
	}

	const signatures = ALLOWED_IMAGE_TYPES[mimetype].signatures;

	for (const signature of signatures) {
		if (!matchesSignature(buffer, signature)) {
			continue;
		}

		if (mimetype === 'image/webp' && !matchesSignature(buffer, WEBP_FOURCC, WEBP_FOURCC_OFFSET)) {
			continue;
		}

		return true;
	}

	return false;
}

function sanitizeFilename(filename) {
	if (!filename || typeof filename !== 'string') {
		throw new Error('Invalid filename: empty or not a string');
	}

	if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
		throw new Error('Invalid filename: contains dangerous characters or patterns');
	}

	const basename = path.basename(filename);

	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(basename)) {
			throw new Error('Invalid filename: contains dangerous characters or patterns');
		}
	}

	const sanitized = basename
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\w\s.-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.toLowerCase()
		.substring(0, 255);

	if (!sanitized || sanitized === '.' || sanitized === '..' || sanitized.includes('..')) {
		throw new Error('Invalid filename after sanitization');
	}

	return sanitized;
}

function validateFileExtension(filename, mimetype) {
	if (!ALLOWED_IMAGE_TYPES[mimetype]) {
		return false;
	}

	const ext = path.extname(filename).toLowerCase();
	const allowedExtensions = ALLOWED_IMAGE_TYPES[mimetype].extensions;

	return allowedExtensions.includes(ext);
}

function validateMimeType(mimetype) {
	return Object.keys(ALLOWED_IMAGE_TYPES).includes(mimetype);
}

async function validateImageFile(file) {
	const errors = [];

	if (!file || !file.buffer) {
		throw new Error('No file provided');
	}

	if (file.size > MAX_FILE_SIZE) {
		throw new Error(`File size exceeds maximum allowed size of ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
	}

	if (file.size === 0) {
		throw new Error('File is empty');
	}

	if (!validateMimeType(file.mimetype)) {
		throw new Error(`Invalid MIME type: ${file.mimetype}. Allowed types: ${Object.keys(ALLOWED_IMAGE_TYPES).join(', ')}`);
	}

	if (!validateFileExtension(file.originalname, file.mimetype)) {
		throw new Error(`File extension does not match MIME type ${file.mimetype}`);
	}

	if (!checkFileSignature(file.buffer, file.mimetype)) {
		throw new Error('File signature does not match declared type. Possible malicious file.');
	}

	try {
		sanitizeFilename(file.originalname);
	} catch (error) {
		throw new Error(`Filename validation failed: ${error.message}`);
	}

	return true;
}

function generateSecureFilename(originalFilename) {
	const ext = path.extname(originalFilename).toLowerCase();
	const timestamp = Date.now();
	// Math.random() is not cryptographically secure and its output is
	// predictable enough to make filenames guessable. crypto.randomBytes is.
	const randomStr = crypto.randomBytes(12).toString('hex');

	return `image-${timestamp}-${randomStr}${ext}`;
}

module.exports = {
	validateImageFile,
	sanitizeFilename,
	generateSecureFilename,
	MAX_FILE_SIZE,
	ALLOWED_IMAGE_TYPES
};
