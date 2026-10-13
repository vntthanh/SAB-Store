/**
 * Vietnamese customer mails for an order. Every interpolated value is HTML-escaped
 * (names, product names, the cancel reason and the store title are all free text);
 * the plain-text part carries the same facts without markup.
 */
const { ORDER_STATUSES } = require('@sab/shared');
const { formatCurrency } = require('../utils/helpers');
const { escapeHtml } = require('../utils/escape-html');

const FALLBACK_STORE_TITLE = 'SAB Store';

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
		name: item.productName,
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

function renderOrderCreated(order, storeTitle) {
	const lines = itemLines(order);
	const total = formatCurrency(order.totalAmount);
	const heading = `Xác nhận đơn hàng ${order.orderCode}`;

	const rows = lines
		.map((line) => `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(line.name)} × ${escapeHtml(line.quantity)}</td><td style="padding:4px 0;text-align:right">${escapeHtml(line.amount)}</td></tr>`)
		.join('');
	const html = shell(storeTitle, heading, [
		`<p>${escapeHtml(greeting(order))}</p>`,
		`<p>Cảm ơn bạn đã đặt hàng. Mã đơn hàng của bạn là <strong>${escapeHtml(order.orderCode)}</strong>.</p>`,
		`<table style="border-collapse:collapse;width:100%">${rows}`,
		`<tr><td style="padding:8px 12px 4px 0;border-top:1px solid #ddd"><strong>Tổng cộng</strong></td><td style="padding:8px 0 4px;border-top:1px solid #ddd;text-align:right"><strong>${escapeHtml(total)}</strong></td></tr></table>`,
		order.paymentDescription
			? `<p>Nội dung chuyển khoản: <strong>${escapeHtml(order.paymentDescription)}</strong></p>`
			: ''
	].join(''));

	const text = [
		greeting(order),
		`Cảm ơn bạn đã đặt hàng. Mã đơn hàng của bạn là ${order.orderCode}.`,
		'',
		...lines.map((line) => `- ${line.name} × ${line.quantity}: ${line.amount}`),
		`Tổng cộng: ${total}`,
		...(order.paymentDescription ? ['', `Nội dung chuyển khoản: ${order.paymentDescription}`] : []),
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

module.exports = { renderOrderMail };
