const { renderOtpMail } = require('../../services/mail-templates');

const HOSTILE = `<script>alert("x")</script> & 'q'`;

describe('renderOtpMail', () => {
	it('carries the code, the lifetime and the do-not-share line in both parts', () => {
		const { subject, html, text } = renderOtpMail('123456', 5, 'SAB Store');

		expect(subject).toBe('[SAB Store] Mã đăng nhập');
		for (const part of [html, text]) {
			expect(part).toContain('123456');
			expect(part).toContain('5 phút');
			expect(part).toContain('không chia sẻ');
		}
	});

	it('escapes the store title and leaves no raw markup', () => {
		const { html } = renderOtpMail('123456', 5, HOSTILE);

		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('keeps a header-breaking title on one line and falls back when it is missing', () => {
		expect(renderOtpMail('123456', 5, 'Line one\r\nBcc: x@y.z').subject).not.toMatch(/[\r\n]/);
		expect(renderOtpMail('123456', 5).subject).toBe('[SAB Store] Mã đăng nhập');
	});
});
