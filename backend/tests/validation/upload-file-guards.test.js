const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const { MAX_FILE_SIZE } = require('../../utils/fileValidator');

// /api/upload requires an admin session (Phase 00 A3 / Q6) — every request
// here goes through makeAdminSession first so it exercises the guards this
// phase owns, not the auth guard Phase 00/04 already covers.
describe('Upload file guards', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('MAX_FILE_SIZE is 10MB', () => {
		expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
	});

	it('rejects a file over 10MB with 400, not a raw 500/413', async () => {
		const { cookies } = await makeAdminSession(app);
		// A valid PNG signature followed by padding — multer's size limit
		// trips before fileValidator ever inspects the bytes.
		const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const oversized = Buffer.concat([pngSignature, Buffer.alloc(11 * 1024 * 1024)]);

		const res = await request(app)
			.post('/api/upload/product-image')
			.set('Cookie', cookies)
			.attach('image', oversized, { filename: 'big.png', contentType: 'image/png' });

		expect(res.status).toBe(400);
		expect(res.body.success).toBe(false);
	});

	it('rejects a non-WebP RIFF container (e.g. AVI/WAV) disguised as .webp', async () => {
		const { cookies } = await makeAdminSession(app);
		// RIFF signature (bytes 0-3) but "AVI " instead of "WEBP" at offset 8-11
		// — passes a signature check that only looks at the first 4 bytes.
		const fakeAvi = Buffer.concat([
			Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF
			Buffer.from([0x00, 0x00, 0x00, 0x00]), // file size (unused by the check)
			Buffer.from('AVI '),
			Buffer.alloc(32)
		]);

		const res = await request(app)
			.post('/api/upload/product-image')
			.set('Cookie', cookies)
			.attach('image', fakeAvi, { filename: 'fake.webp', contentType: 'image/webp' });

		expect(res.status).toBe(400);
		expect(res.body.success).toBe(false);
		expect(res.body.message).toMatch(/signature/i);
	});

	it('accepts a genuine WebP signature at the fileValidator stage', async () => {
		const realWebp = Buffer.concat([
			Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF
			Buffer.from([0x00, 0x00, 0x00, 0x00]),
			Buffer.from('WEBP'),
			Buffer.alloc(32)
		]);

		const { validateImageFile } = require('../../utils/fileValidator');
		await expect(
			validateImageFile({
				buffer: realWebp,
				size: realWebp.length,
				mimetype: 'image/webp',
				originalname: 'real.webp'
			})
		).resolves.toBe(true);
	});

	it('does not respond with a raw internal error message on a server-side failure', async () => {
		const { cookies } = await makeAdminSession(app);
		const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

		// No live MinIO in this test env, so uploadFile() itself fails — the
		// route must not echo error.message (MinIO host/credentials/stack) and
		// must respond with a correlation id instead.
		const res = await request(app)
			.post('/api/upload/product-image')
			.set('Cookie', cookies)
			.attach('image', pngSignature, { filename: 'ok.png', contentType: 'image/png' });

		expect(res.status).toBe(500);
		expect(res.body).not.toHaveProperty('error');
		expect(res.body).toHaveProperty('correlationId');
	});
});
