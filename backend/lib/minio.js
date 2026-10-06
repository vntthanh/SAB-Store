const Minio = require('minio');
require('dotenv').config();

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'localhost';
const MINIO_PORT = parseInt(process.env.MINIO_PORT || '9000');
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
const MINIO_BUCKET_NAME = process.env.MINIO_BUCKET_NAME || 'sabstore';
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';

const minioClient = new Minio.Client({
	endPoint: MINIO_ENDPOINT,
	port: MINIO_PORT,
	useSSL: MINIO_USE_SSL,
	accessKey: MINIO_ACCESS_KEY,
	secretKey: MINIO_SECRET_KEY
});

/**
 * Initialize storage bucket
 * Creates bucket if it doesn't exist and sets public read policy
 */
const initializeBucket = async () => {
	try {
		const bucketExists = await minioClient.bucketExists(MINIO_BUCKET_NAME);

		if (!bucketExists) {
			await minioClient.makeBucket(MINIO_BUCKET_NAME, 'us-east-1');
			console.log(`[Storage] Bucket '${MINIO_BUCKET_NAME}' created successfully`);
		} else {
			console.log(`[Storage] Bucket '${MINIO_BUCKET_NAME}' already exists`);
		}
	} catch (error) {
		console.error('[Storage] Error initializing bucket:', error);
		throw error;
	}

	const policy = {
		Version: '2012-10-17',
		Statement: [
			{
				Effect: 'Allow',
				Principal: { AWS: ['*'] },
				Action: ['s3:GetObject'],
				Resource: [`arn:aws:s3:::${MINIO_BUCKET_NAME}/*`]
			}
		]
	};

	// Some S3 backends reject or ignore bucket policies (public read is then
	// configured out of band). A working bucket must not stop the backend booting.
	try {
		await minioClient.setBucketPolicy(MINIO_BUCKET_NAME, JSON.stringify(policy));
		console.log(`[Storage] Public read policy applied to bucket '${MINIO_BUCKET_NAME}'`);
	} catch (error) {
		console.warn(`[Storage] bucket policy not applied: ${error.message}`);
	}
};

/**
 * Upload file to object storage
 * @param {string} objectName - Object name in bucket (e.g., 'products/image.jpg')
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} Object name
 */
const uploadFile = async (objectName, fileBuffer, contentType) => {
	try {
		const metaData = {
			'Content-Type': contentType
		};

		await minioClient.putObject(
			MINIO_BUCKET_NAME,
			objectName,
			fileBuffer,
			fileBuffer.length,
			metaData
		);

		console.log(`[Storage] File uploaded successfully: ${objectName}`);
		return objectName;
	} catch (error) {
		console.error('[Storage] Error uploading file:', error);
		throw error;
	}
};

/**
 * Get file from object storage
 * @param {string} objectName - Object name in bucket
 * @returns {Promise<Stream>} File stream
 */
const getFile = async (objectName) => {
	try {
		const stream = await minioClient.getObject(MINIO_BUCKET_NAME, objectName);
		return stream;
	} catch (error) {
		console.error('[Storage] Error getting file:', error);
		throw error;
	}
};

/**
 * Delete file from object storage
 * @param {string} objectName - Object name in bucket
 * @returns {Promise<void>}
 */
const deleteFile = async (objectName) => {
	try {
		await minioClient.removeObject(MINIO_BUCKET_NAME, objectName);
		console.log(`[Storage] File deleted successfully: ${objectName}`);
	} catch (error) {
		console.error('[Storage] Error deleting file:', error);
		throw error;
	}
};

/**
 * Get file metadata
 * @param {string} objectName - Object name in bucket
 * @returns {Promise<Object>} File metadata
 */
const getFileMetadata = async (objectName) => {
	try {
		const stat = await minioClient.statObject(MINIO_BUCKET_NAME, objectName);
		return stat;
	} catch (error) {
		console.error('[Storage] Error getting file metadata:', error);
		throw error;
	}
};

module.exports = {
	minioClient,
	initializeBucket,
	uploadFile,
	getFile,
	deleteFile,
	getFileMetadata,
	MINIO_BUCKET_NAME
};
