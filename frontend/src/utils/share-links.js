// Đường dẫn công khai khớp với nginx (/p, /c) và `path` do API trả về.
// Giống server: thiếu slug → mã viết thường; thiếu mã (dữ liệu chưa backfill) → null, không có link.
const publicPath = (prefix, { publicCode, slug } = {}) =>
	publicCode ? `/${prefix}/${publicCode}/${slug || publicCode.toLowerCase()}` : null;
export const productPath = (product) => publicPath('p', product);
export const comboPath = (combo) => publicPath('c', combo);

// Chỉ nhận đường dẫn /p/… hoặc /c/… của chính site: '//evil.com' hay URL tuyệt đối
// sẽ dẫn link chia sẻ sang domain khác.
export const absoluteUrl = (path) => {
	if (typeof path !== 'string' || !/^\/[pc]\/[^/]/.test(path)) return '';
	const url = new URL(path, window.location.origin);
	return url.origin === window.location.origin ? url.toString() : '';
};

// Trình duyệt cũ / in-app browser (Zalo, Messenger) có thể thiếu Clipboard API
// hoặc chạy ngoài secure context, nên phải có đường lui execCommand.
const copyWithExecCommand = (text) => {
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.setAttribute('readonly', '');
	textarea.style.position = 'fixed';
	textarea.style.top = '0';
	textarea.style.opacity = '0';
	document.body.appendChild(textarea);
	try {
		textarea.focus();
		textarea.select();
		textarea.setSelectionRange(0, text.length);
		return document.execCommand('copy');
	} finally {
		document.body.removeChild(textarea);
	}
};

/**
 * Sao chép url vào clipboard.
 * 'copied' = đã chép; 'manual' = mọi cách đều thất bại, caller phải cho người dùng tự chép.
 */
export const copyLink = async (url) => {
	if (navigator.clipboard && window.isSecureContext) {
		try {
			await navigator.clipboard.writeText(url);
			return 'copied';
		} catch (error) {
			// Quyền bị từ chối hoặc tài liệu mất focus: thử đường lui bên dưới.
		}
	}
	try {
		return copyWithExecCommand(url) ? 'copied' : 'manual';
	} catch (error) {
		return 'manual';
	}
};
