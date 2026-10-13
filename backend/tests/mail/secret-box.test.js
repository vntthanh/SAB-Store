const { encryptSecret, decryptSecret } = require('../../lib/secret-box');

describe('secret-box', () => {
	it('round-trips a secret, including non-ASCII text', () => {
		for (const secret of ['hunter2', 'mật khẩu-Ü-🔑', 'a'.repeat(256)]) {
			expect(decryptSecret(encryptSecret(secret))).toBe(secret);
		}
	});

	it('writes the v1 envelope and a fresh iv every time', () => {
		const first = encryptSecret('same');
		const second = encryptSecret('same');
		expect(first).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
		expect(first).not.toBe(second);
		expect(first).not.toContain('same');
	});

	it('returns null for a tampered ciphertext, tag or iv', () => {
		const [version, iv, tag, data] = encryptSecret('hunter2').split(':');
		const flip = (b64) => Buffer.from(b64, 'base64').map((byte, i) => (i === 0 ? byte ^ 1 : byte)).toString('base64');
		expect(decryptSecret([version, iv, tag, flip(data)].join(':'))).toBeNull();
		expect(decryptSecret([version, iv, flip(tag), data].join(':'))).toBeNull();
		expect(decryptSecret([version, flip(iv), tag, data].join(':'))).toBeNull();
	});

	it.each(['', 'v1', 'v2:a:b:c', 'v1:a:b', 'not an envelope at all'])('returns null for malformed input %j', (value) => {
		expect(decryptSecret(value)).toBeNull();
	});

	it('returns null once JWT_SECRET has changed', () => {
		const envelope = encryptSecret('hunter2');
		const original = process.env.JWT_SECRET;
		process.env.JWT_SECRET = `${original}-rotated`;
		try {
			expect(decryptSecret(envelope)).toBeNull();
		} finally {
			process.env.JWT_SECRET = original;
		}
		expect(decryptSecret(envelope)).toBe('hunter2');
	});
});
