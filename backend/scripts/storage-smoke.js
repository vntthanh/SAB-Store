#!/usr/bin/env node
/**
 * Object storage smoke test.
 *
 * Exercises the same client the app uses, so a PASS means uploads from this
 * process really work against the configured endpoint. With a public base URL
 * it also proves anonymous readers can GET objects but cannot write.
 *
 * Output never includes credentials or the endpoint.
 */
const { randomUUID } = require('crypto');
const { minioClient, MINIO_BUCKET_NAME } = require('../lib/minio');

const CONTENT_TYPE = 'text/plain';

class SmokeError extends Error {
	constructor(step, detail) {
		super(`${step}: ${detail}`);
		this.step = step;
	}
}

function assert(condition, step, detail) {
	if (!condition) throw new SmokeError(step, detail);
}

async function readStream(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}

async function step(name, fn) {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof SmokeError) throw error;
		throw new SmokeError(name, error.code || error.name || 'unexpected error');
	}
}

async function checkPublicAccess(publicBaseUrl, objectName, body) {
	// Through the public /uploads/ proxy, so the check covers nginx's rewrite and
	// method filter, not just the bucket policy.
	const url = `${publicBaseUrl.replace(/\/+$/, '')}/uploads/${objectName}`;

	await step('anonymous-get', async () => {
		const res = await fetch(url);
		assert(res.status === 200, 'anonymous-get', `expected 200, got ${res.status}`);
		assert((await res.text()) === body, 'anonymous-get', 'body mismatch');
	});

	await step('anonymous-put-denied', async () => {
		const res = await fetch(url, { method: 'PUT', body: 'overwrite' });
		assert(res.status === 403, 'anonymous-put-denied', `expected 403, got ${res.status}`);
	});
}

// Straight at the storage endpoint without a signature. nginx already blocks
// writes on /uploads/; this proves the server itself enforces its identities,
// which it silently stops doing if it cannot read its identity file.
async function checkDirectWriteDenied(objectName) {
	const scheme = process.env.MINIO_USE_SSL === 'true' ? 'https' : 'http';
	const host = `${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || '9000'}`;
	const url = `${scheme}://${host}/${MINIO_BUCKET_NAME}/${objectName}.unsigned`;

	await step('unsigned-put-denied', async () => {
		const res = await fetch(url, { method: 'PUT', body: 'unsigned' });
		assert(res.status === 403, 'unsigned-put-denied', `expected 403, got ${res.status}`);
	});
}

/**
 * @param {{ publicBaseUrl?: string }} [options]
 * @returns {Promise<{ ok: true } | { ok: false, step: string, detail: string }>}
 */
async function run({ publicBaseUrl } = {}) {
	const objectName = `smoke/${randomUUID()}.txt`;
	const body = `smoke-${randomUUID()}`;
	let uploaded = false;
	let failure = null;

	try {
		await step('bucket-exists', async () => {
			assert(await minioClient.bucketExists(MINIO_BUCKET_NAME), 'bucket-exists', 'bucket missing');
		});

		await step('put', async () => {
			await minioClient.putObject(MINIO_BUCKET_NAME, objectName, Buffer.from(body), Buffer.byteLength(body), {
				'Content-Type': CONTENT_TYPE,
			});
			uploaded = true;
		});

		await step('stat', async () => {
			const stat = await minioClient.statObject(MINIO_BUCKET_NAME, objectName);
			assert(stat.size === Buffer.byteLength(body), 'stat', `size ${stat.size}`);
			const type = stat.metaData && stat.metaData['content-type'];
			assert(type === CONTENT_TYPE, 'stat', `content-type ${type}`);
		});

		await step('get', async () => {
			const data = await readStream(await minioClient.getObject(MINIO_BUCKET_NAME, objectName));
			assert(data.toString() === body, 'get', 'body mismatch');
		});

		await checkDirectWriteDenied(objectName);
		if (publicBaseUrl) await checkPublicAccess(publicBaseUrl, objectName, body);
	} catch (error) {
		failure = error;
	}

	// Always remove the probe, even after a failed step, so failed runs leave no litter.
	if (uploaded) {
		try {
			await minioClient.removeObject(MINIO_BUCKET_NAME, objectName);
			await step('stat-after-delete', async () => {
				try {
					await minioClient.statObject(MINIO_BUCKET_NAME, objectName);
				} catch (error) {
					if (error.code === 'NotFound') return;
					throw error;
				}
				throw new SmokeError('stat-after-delete', 'object still present');
			});
		} catch (error) {
			failure = failure || (error instanceof SmokeError ? error : new SmokeError('remove', error.code || error.name));
		}
	}

	if (failure) return { ok: false, step: failure.step || 'unknown', detail: failure.message };
	return { ok: true };
}

function parseArgs(argv) {
	const arg = argv.find((a) => a.startsWith('--public-base-url='));
	return { publicBaseUrl: arg ? arg.slice('--public-base-url='.length) : undefined };
}

if (require.main === module) {
	run(parseArgs(process.argv.slice(2)))
		.then((result) => {
			if (result.ok) {
				console.log('PASS');
				process.exit(0);
			}
			console.error(`FAIL ${result.step} (${result.detail})`);
			process.exit(1);
		})
		.catch((error) => {
			console.error(`FAIL unexpected (${error.code || error.name})`);
			process.exit(1);
		});
}

module.exports = { run };
