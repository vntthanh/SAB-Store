/**
 * The 1200x630 share image, composed from the product photos.
 *
 * Runs in the API process because there is no worker to hand it to; the cost is
 * contained instead: one render at a time with a short queue, no sharp cache,
 * capped input size and pixel count, and nginx caches the result per version.
 * The backend container has 256 MB shared with checkout and the stock worker.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const minio = require('../lib/minio');
const { comboImageUrls } = require('./public-catalog');

sharp.cache(false);
sharp.concurrency(1);

const WIDTH = 1200;
const HEIGHT = 630;
const BOX = { left: 80, top: 55, width: 1040, height: 520 };
const GAP = 20;
const BACKGROUND = '#1e40af';
const ACCENT = '#eab308';
const PANEL = '#f8fafc';
const LOGO_WIDTH = 150;
const SOURCE_MAX_BYTES = 10 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 3000;
const MAX_INPUT_PIXELS = 12e6;
const JPEG_QUALITIES = [82, 70, 58];
const RESULT_MAX_BYTES = 300 * 1024;
const MAX_WAITING = 2;
const UPLOADS_PREFIX = '/uploads/';
const ASSET_DIR = path.join(__dirname, '..', 'assets', 'og');

class OgBusyError extends Error {
	constructor() {
		super('Share image renderer is busy');
		this.name = 'OgBusyError';
	}
}

let running = false;
const queue = [];

function acquire() {
	if (!running) {
		running = true;
		return Promise.resolve();
	}
	if (queue.length >= MAX_WAITING) return Promise.reject(new OgBusyError());
	return new Promise((resolve) => queue.push(resolve));
}

function release() {
	const next = queue.shift();
	if (next) next();
	else running = false;
}

const assetCache = new Map();
function readAsset(name) {
	if (!assetCache.has(name)) assetCache.set(name, fs.promises.readFile(path.join(ASSET_DIR, name)));
	return assetCache.get(name);
}

/**
 * Bytes of an object we host, bounded in size and time. The path comes from our
 * own database, but only `/uploads/` objects are read: nothing is fetched by URL.
 */
function readUpload(objectName) {
	return new Promise((resolve, reject) => {
		let stream;
		let settled = false;
		const finish = (error, buffer) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) {
				if (stream) stream.destroy();
				reject(error);
			} else {
				resolve(buffer);
			}
		};
		const timer = setTimeout(() => finish(new Error('Source image read timed out')), SOURCE_TIMEOUT_MS);

		(async () => {
			const stat = await minio.getFileMetadata(objectName);
			if (!stat || !(stat.size <= SOURCE_MAX_BYTES)) throw new Error('Source image missing size or too large');
			stream = await minio.getFile(objectName);
			if (settled) {
				stream.destroy();
				return;
			}
			const chunks = [];
			let total = 0;
			stream.on('data', (chunk) => {
				total += chunk.length;
				if (total > SOURCE_MAX_BYTES) return finish(new Error('Source image too large'));
				chunks.push(chunk);
			});
			stream.on('error', finish);
			stream.on('end', () => finish(null, Buffer.concat(chunks)));
		})().catch(finish);
	});
}

// A photo that cannot be read or decoded falls back to the stock picture, so a
// broken upload degrades the preview instead of failing the share.
async function sourceBuffer(imageUrl) {
	if (typeof imageUrl === 'string' && imageUrl.startsWith(UPLOADS_PREFIX) && imageUrl.length > UPLOADS_PREFIX.length) {
		try {
			return await readUpload(imageUrl.slice(UPLOADS_PREFIX.length));
		} catch (error) {
			console.warn(`[OgImage] using fallback picture: ${error.message}`);
		}
	}
	return readAsset('fallback.png');
}

function fitInto(buffer, width, height) {
	return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
		.rotate()
		.resize({ width, height, fit: 'contain', background: PANEL })
		.flatten({ background: PANEL })
		.png()
		.toBuffer();
}

async function cell(imageUrl, box) {
	let input;
	try {
		input = await fitInto(await sourceBuffer(imageUrl), box.width, box.height);
	} catch (error) {
		console.warn(`[OgImage] undecodable source, using fallback picture: ${error.message}`);
		input = await fitInto(await readAsset('fallback.png'), box.width, box.height);
	}
	return { input, left: box.left, top: box.top };
}

function layout(count) {
	const { left, top, width, height } = BOX;
	if (count <= 1) return [BOX];
	const half = (size) => Math.floor((size - GAP) / 2);
	if (count === 2) {
		return [0, 1].map((i) => ({ left: left + i * (half(width) + GAP), top, width: half(width), height }));
	}
	return [0, 1, 2, 3].slice(0, count).map((i) => ({
		left: left + (i % 2) * (half(width) + GAP),
		top: top + Math.floor(i / 2) * (half(height) + GAP),
		width: half(width),
		height: half(height)
	}));
}

async function frame() {
	const logo = await sharp(await readAsset('logo.png')).resize({ width: LOGO_WIDTH }).png().toBuffer();
	const logoHeight = (await sharp(logo).metadata()).height;
	const pad = 10;
	const pill = { width: LOGO_WIDTH + pad * 2, height: logoHeight + pad * 2 };
	pill.left = BOX.left + BOX.width - pill.width;
	pill.top = BOX.top + BOX.height - pill.height;
	const svg = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
		`<rect x="0" y="0" width="18" height="${HEIGHT}" fill="${ACCENT}"/>` +
		`<rect x="${pill.left}" y="${pill.top}" width="${pill.width}" height="${pill.height}" rx="12" fill="#ffffff" fill-opacity="0.94"/>` +
		'</svg>'
	);
	return { overlay: { input: svg, left: 0, top: 0 }, logo: { input: logo, left: pill.left + pad, top: pill.top + pad } };
}

async function compose(imageUrls) {
	const urls = imageUrls.length ? imageUrls : [null];
	// One cell at a time: up to four decodes of 12 MP images in flight would not
	// fit the backend container's 256 MB next to everything else it runs.
	const cells = [];
	for (const [i, box] of layout(urls.length).entries()) {
		cells.push(await cell(urls[i], box));
	}
	const { overlay, logo } = await frame();

	const base = () => sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: BACKGROUND } })
		.composite([...cells, overlay, logo]);

	let result;
	for (const quality of JPEG_QUALITIES) {
		result = await base().jpeg({ quality, mozjpeg: true }).toBuffer();
		if (result.length <= RESULT_MAX_BYTES) break;
	}
	return result;
}

/**
 * @param {object} publicThing a PublicProduct or PublicCombo
 * @returns {Promise<Buffer>} JPEG
 * @throws {OgBusyError} when a render is running and the queue is full
 */
async function renderOgImage(publicThing) {
	const imageUrls = Array.isArray(publicThing.requirements) ? comboImageUrls(publicThing) : [publicThing.imageUrl];
	await acquire();
	try {
		return await compose(imageUrls);
	} finally {
		release();
	}
}

module.exports = { renderOgImage, OgBusyError };
