const { renderOrderMail } = require('../../services/mail-templates');

const HOSTILE = `<script>alert("x")</script> & 'q'`;
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;';

const regexSource = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe.each(['order_created', 'status_changed'])('%s with hostile values', (kind) => {
		it('escapes every free-text value in the HTML and leaves no raw markup', () => {
			const { html } = renderOrderMail(kind, order(), HOSTILE);

			expect(html).not.toContain('<script>');
			expect(html).not.toContain('alert("x")');
			expect(html).toContain(ESCAPED);
		});
	});

	describe('new order mail', () => {
		const full = (patch = {}) => order({
			studentId: '24120001',
			phoneNumber: '0987654321',
			additionalNote: 'Giao giờ nghỉ trưa',
			createdAt: new Date('2026-10-25T07:05:00Z'),
			status: undefined,
			cancelReason: undefined,
			...patch
		});

		// The text of the template's `<li><b>label</b> value</li>` row.
		const row = (html, label) => {
			const match = new RegExp(`<b>${label}:</b>\\s*([^<]*?)\\s*</li>`).exec(html);
			return match && match[1];
		};

		it('escapes the name, student id, phone, product, payment description and note, each in its own slot', () => {
			const { html } = renderOrderMail('order_created', full({ additionalNote: HOSTILE, studentId: HOSTILE, phoneNumber: HOSTILE }), 'SAB');

			expect(html).toMatch(new RegExp(`${regexSource(ESCAPED)}\\s*-\\s*${regexSource(ESCAPED)}`));
			expect(row(html, 'Số điện thoại')).toBe(ESCAPED);
			expect(row(html, 'Nội dung chuyển khoản')).toBe(ESCAPED);
			expect(row(html, 'Ghi chú')).toBe(ESCAPED);
			expect(html).toContain(`<td style="padding:2px 12px 2px 0">${ESCAPED} × 2</td>`);
			expect(html).not.toMatch(/<script|alert\("x"\)/);
		});

		it('escapes the order code in the tracking link and the text', () => {
			const { html, text } = renderOrderMail('order_created', full({ orderCode: 'A"><b>' }), 'SAB');

			expect(html).not.toContain('A"><b>');
			expect(html).toContain('code=A%22%3E%3Cb%3E');
			expect(text).toContain('code=A%22%3E%3Cb%3E');
			expect(text).not.toContain('code=A"><b>');
		});

		it('fills each slot with its own value', () => {
			const { html } = renderOrderMail('order_created', full({
				fullName: 'Nguyen Van A',
				totalAmount: 55000,
				items: [{ productName: 'Áo', price: 10000, quantity: 2 }]
			}), 'SAB');

			expect(row(html, 'Số điện thoại')).toBe('0987654321');
			expect(row(html, 'Ghi chú')).toBe('Giao giờ nghỉ trưa');
			expect(row(html, 'Tổng số tiền')).toMatch(/^55\.000/);
			expect(html).toMatch(/24120001\s*-\s*Nguyen Van A/);
			expect(html).toMatch(/<td style="padding:2px 12px 2px 0">Áo × 2<\/td><td style="padding:2px 0;text-align:right">20\.000/);
			expect(html).toContain('Nội dung chuyển khoản');
		});

		it('names the variant of a line after the product, escaped', () => {
			const { html, text } = renderOrderMail('order_created', full({
				items: [{ productName: 'Áo', variantLabel: 'Đỏ / <M>', price: 10000, quantity: 1 }, { productName: 'Thẻ', price: 5000, quantity: 1 }]
			}), 'SAB');

			expect(html).toContain('Áo — Đỏ / &lt;M&gt; × 1');
			expect(html).toContain('Thẻ × 1');
			expect(text).toContain('Áo — Đỏ / <M>');
		});

		it('renders an apostrophe as &#39;, the output of the custom escaper', () => {
			const { html } = renderOrderMail('order_created', full({ fullName: "O'Brien" }), 'SAB');

			expect(html).toContain('O&#39;Brien');
			expect(html).not.toContain("O'Brien");
		});

		it('shows the order date in Vietnam time as dd/MM/yyyy HH:mm', () => {
			const { html } = renderOrderMail('order_created', full(), 'SAB');

			expect(html).toContain('25/10/2026 14:05');
		});

		it('links to the order tracking page on the configured public origin', () => {
			vi.stubEnv('BASE_URL', 'https://store.example.test/');
			const { html, text } = renderOrderMail('order_created', full({ orderCode: 'SAB123' }), 'SAB');

			expect(html).toContain('href="https://store.example.test/order-tracking?code=SAB123"');
			expect(text).toContain('https://store.example.test/order-tracking?code=SAB123');
		});

		it('omits the transfer content row when there is no payment description', () => {
			const { html } = renderOrderMail('order_created', full({ paymentDescription: undefined }), 'SAB');

			expect(html).not.toContain('Nội dung chuyển khoản');
		});
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
