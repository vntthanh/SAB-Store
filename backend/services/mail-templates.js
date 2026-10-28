/**
 * Vietnamese customer mails for an order. Every interpolated value is HTML-escaped
 * (names, product names, the cancel reason and the store title are all free text);
 * the plain-text part carries the same facts without markup.
 */
const fs = require('fs');
const path = require('path');
// Mustache over Handlebars or string replace: escapes by default, no helpers needed, no dependencies.
const Mustache = require('mustache');
const { ORDER_STATUSES } = require('@sab/shared');
const { formatCurrency } = require('../utils/helpers');
const { escapeHtml } = require('../utils/escape-html');

const FALLBACK_STORE_TITLE = 'SAB Store';
const DISPLAY_TIME_ZONE = 'Asia/Ho_Chi_Minh';
// Same fallback as lib/auth.js, for a development run without BASE_URL.
const DEFAULT_PUBLIC_URL = 'http://localhost:5000';

// Read once at load: a missing template must stop the boot, not silently degrade to a text-only mail.
const ORDER_CREATED_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'templates', 'order-created.html'), 'utf8');

const STATUS_LABELS = {
	confirmed: 'Đã xác nhận',
	paid: 'Đã thanh toán',
	delivered: 'Đã giao hàng',
	cancelled: 'Đã hủy'
};

// A header value must stay on one line whatever an admin typed into the title.
const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

const statusLabel = (status) => (ORDER_STATUSES.includes(status) ? STATUS_LABELS[status] : String(status));

function itemLines(order) {
	return (order.items || []).map((item) => ({
		name: item.variantLabel ? `${item.productName} — ${item.variantLabel}` : item.productName,
		quantity: item.quantity,
		amount: formatCurrency(item.price * item.quantity)
	}));
}

function shell(storeTitle, heading, bodyHtml) {
	return [
		'<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:560px">',
		`<h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>`,
		bodyHtml,
		`<p style="margin-top:24px;color:#666">${escapeHtml(storeTitle)}</p>`,
		'</div>'
	].join('');
}

function greeting(order) {
	return order.fullName ? `Chào ${order.fullName},` : 'Xin chào,';
}

function formatOrderDate(value) {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: DISPLAY_TIME_ZONE,
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).format(new Date(value)).replace(',', '');
}

// The one raw slot of the template: every cell is escaped here, before it is joined.
function itemsTable(lines) {
	const rows = lines
		.map((line) => `<tr><td style="padding:2px 12px 2px 0">${escapeHtml(line.name)} × ${escapeHtml(line.quantity)}</td><td style="padding:2px 0;text-align:right">${escapeHtml(line.amount)}</td></tr>`)
		.join('');
	return `<table style="border-collapse:collapse">${rows}</table>`;
}

function trackingUrl(orderCode) {
	const base = (process.env.BASE_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, '');
	return `${base}/order-tracking?code=${encodeURIComponent(orderCode)}`;
}

function renderOrderCreated(order, storeTitle) {
	const lines = itemLines(order);
	const total = formatCurrency(order.totalAmount);

	const html = Mustache.render(ORDER_CREATED_TEMPLATE, {
		fullName: order.fullName,
		orderCode: order.orderCode,
		studentId: order.studentId,
		phoneNumber: order.phoneNumber,
		date: formatOrderDate(order.createdAt || Date.now()),
		itemsHtml: itemsTable(lines),
		totalAmount: total,
		paymentDescription: order.paymentDescription,
		additionalNote: order.additionalNote || 'Không có',
		trackingUrl: trackingUrl(order.orderCode)
	}, {}, { escape: escapeHtml });

	const text = [
		greeting(order),
		`Cảm ơn bạn đã đặt hàng. Mã đơn hàng của bạn là ${order.orderCode}.`,
		'',
		...lines.map((line) => `- ${line.name} × ${line.quantity}: ${line.amount}`),
		`Tổng cộng: ${total}`,
		...(order.paymentDescription ? ['', `Nội dung chuyển khoản: ${order.paymentDescription}`] : []),
		'',
		`Tra cứu đơn hàng: ${trackingUrl(order.orderCode)}`,
		'',
		storeTitle
	].join('\n');

	return { subject: `[${oneLine(storeTitle)}] Xác nhận đơn hàng ${order.orderCode}`, html, text };
}

function renderStatusChanged(order, storeTitle) {
	const label = statusLabel(order.status);
	const reason = order.status === 'cancelled' && order.cancelReason ? order.cancelReason : '';
	const heading = `Đơn hàng ${order.orderCode}: ${label}`;

	const html = shell(storeTitle, heading, [
		`<p>${escapeHtml(greeting(order))}</p>`,
		`<p>Đơn hàng <strong>${escapeHtml(order.orderCode)}</strong> của bạn đã chuyển sang trạng thái <strong>${escapeHtml(label)}</strong>.</p>`,
		reason ? `<p>Lý do: ${escapeHtml(reason)}</p>` : ''
	].join(''));

	const text = [
		greeting(order),
		`Đơn hàng ${order.orderCode} của bạn đã chuyển sang trạng thái ${label}.`,
		...(reason ? [`Lý do: ${reason}`] : []),
		'',
		storeTitle
	].join('\n');

	return { subject: `[${oneLine(storeTitle)}] Đơn hàng ${order.orderCode}: ${label}`, html, text };
}

const RENDERERS = {
	order_created: renderOrderCreated,
	status_changed: renderStatusChanged
};

/**
 * @param {'order_created'|'status_changed'} kind
 * @param {object} order record with `orderCode`, `fullName`, `items[]`, `totalAmount`, `status`,
 *   `cancelReason` and, for a new order, `paymentDescription`
 * @param {string} [storeTitle]
 * @returns {{subject: string, html: string, text: string}}
 */
function renderOrderMail(kind, order, storeTitle) {
	const render = RENDERERS[kind];
	if (!render) throw new Error(`Unknown order mail kind: ${kind}`);
	return render(order, oneLine(storeTitle) || FALLBACK_STORE_TITLE);
}

/**
 * The sign-in code mail. `expiresInMinutes` mirrors the emailOTP `expiresIn` so the
 * promise in the mail and the real lifetime cannot drift apart silently.
 *
 * @param {string} code the plain one-time code (the only place it is ever rendered)
 * @param {number} expiresInMinutes
 * @param {string} [storeTitle]
 * @returns {{subject: string, html: string, text: string}}
 */
function renderOtpMail(code, expiresInMinutes, storeTitle) {
	const title = oneLine(storeTitle) || FALLBACK_STORE_TITLE;
	const html = shell(title, 'Mã đăng nhập của bạn', [
		'<p>Dùng mã dưới đây để đăng nhập:</p>',
		`<p style="font-size:28px;font-weight:bold;letter-spacing:6px;margin:16px 0">${escapeHtml(code)}</p>`,
		`<p>Mã có hiệu lực trong ${escapeHtml(expiresInMinutes)} phút. Vì lý do bảo mật, không chia sẻ mã này cho bất kỳ ai.</p>`,
		'<p style="color:#666">Nếu bạn không yêu cầu mã này, hãy bỏ qua thư.</p>'
	].join(''));

	const text = [
		'Mã đăng nhập của bạn:',
		code,
		'',
		`Mã có hiệu lực trong ${expiresInMinutes} phút. Vì lý do bảo mật, không chia sẻ mã này cho bất kỳ ai.`,
		'Nếu bạn không yêu cầu mã này, hãy bỏ qua thư.',
		'',
		title
	].join('\n');

	return { subject: `[${title}] Mã đăng nhập`, html, text };
}

module.exports = { renderOrderMail, renderOtpMail };
