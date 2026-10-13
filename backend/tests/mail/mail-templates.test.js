const { renderOrderMail } = require('../../services/mail-templates');

const HOSTILE = `<script>alert("x")</script> & 'q'`;
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;';

const order = (patch = {}) => ({
	orderCode: 'SAB123',
	fullName: HOSTILE,
	status: 'cancelled',
	cancelReason: HOSTILE,
	paymentDescription: HOSTILE,
	totalAmount: 20000,
	items: [{ productName: HOSTILE, price: 10000, quantity: 2 }],
	...patch
});

describe('renderOrderMail', () => {
	describe.each(['order_created', 'status_changed'])('%s with hostile values', (kind) => {
		it('escapes every free-text value in the HTML and leaves no raw markup', () => {
			const { html } = renderOrderMail(kind, order(), HOSTILE);

			expect(html).not.toContain('<script>');
			expect(html).not.toContain('alert("x")');
			expect(html).toContain(ESCAPED);
		});
	});

	it('escapes the name, product, payment description and store title of a new order', () => {
		const { html } = renderOrderMail('order_created', order(), HOSTILE);

		expect(html).toContain(`Chào ${ESCAPED},`);
		expect(html).toContain(`${ESCAPED} × 2`);
		expect(html).toContain(`<strong>${ESCAPED}</strong>`);
		expect(html.match(new RegExp(ESCAPED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(4);
	});

	it('escapes the cancel reason of a cancelled order', () => {
		const { html } = renderOrderMail('status_changed', order(), 'SAB');

		expect(html).toContain(`Lý do: ${ESCAPED}`);
	});

	it('keeps the plain-text part unescaped', () => {
		const { text } = renderOrderMail('order_created', order(), 'SAB');

		expect(text).toContain(`- ${HOSTILE} × 2`);
	});

	it('keeps the subject on one line when the store title carries a header injection', () => {
		for (const kind of ['order_created', 'status_changed']) {
			const { subject } = renderOrderMail(kind, order(), 'Shop\r\nBcc: x@y.z');

			expect(subject).not.toMatch(/[\r\n]/);
			expect(subject).toContain('Shop Bcc: x@y.z');
		}
	});

	it('falls back to the default store title when none is given', () => {
		expect(renderOrderMail('order_created', order(), '  ').subject).toBe('[SAB Store] Xác nhận đơn hàng SAB123');
	});

	it('throws for an unknown kind', () => {
		expect(() => renderOrderMail('newsletter', order(), 'SAB')).toThrow('Unknown order mail kind: newsletter');
	});
});
