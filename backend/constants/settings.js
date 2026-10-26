/**
 * Defaults, limits and field lists of the store settings. Storage-neutral: any
 * data backend, the routes and the tests read them from here without loading
 * an ORM.
 */
const SETTINGS_KEY = 'payment_config';
// frontend/src/services/api.js repeats both store-title constants and
// NOTICE_MAX_LENGTH for the header fallback and the admin form's limits; keep
// them in sync.
// Defaults for the two bookkeeping fields every backend fills on a first save.
const DEFAULT_PREFIX_MESSAGE = 'SAB';
const DEFAULT_UPDATED_BY = 'system';
const DEFAULT_STORE_TITLE = 'SAB Store';
const STORE_TITLE_MAX_LENGTH = 60;

// Customer-facing reminders, authored as Markdown by an admin. An empty string
// is a deliberate choice that hides the reminder box; only a missing field
// (a row saved before these existed) falls back to the default.
const NOTICE_MAX_LENGTH = 5000;
const DEFAULT_NOTICES = {
	checkoutNotice: [
		'- Vui lòng kiểm tra kỹ thông tin trước khi xác nhận',
		'- Sau khi xác nhận, bạn vui lòng quét mã chuyển khoản trong vòng 1 giờ',
		'- SAB sẽ gửi thông tin xác nhận thanh toán **trong vòng 7 ngày**',
		'- Thời gian nhận hàng dự kiến từ ngày T4 08/10/2025 đến ngày 19/10/2025 tại **Cơ sở 1 - 227 Nguyễn Văn Cừ, Phường Chợ Quán**'
	].join('\n'),
	eventNotice: [
		'- Vui lòng kiểm tra kỹ thông tin trước khi xác nhận.',
		'- Sau khi xác nhận, bạn vui lòng quét mã chuyển khoản trong vòng 1 giờ.'
	].join('\n'),
	paymentNotice: 'Để được xử lý nhanh nhất, bạn vui lòng thanh toán trong vòng 1 giờ'
};
const NOTICE_FIELDS = Object.keys(DEFAULT_NOTICES);

// Footer contact details; same empty-versus-missing rule as the notices.
// Format and length are checked by the admin route against @sab/shared. This module does not import it: the payment
// QR (money path) loads the settings and must not depend on the shared build artifact.
const DEFAULT_CONTACT = {
	contactEmail: 'sab@fit.hcmus.edu.vn',
	contactFacebookUrl: 'https://t.sab.edu.vn/'
};
const CONTACT_FIELDS = Object.keys(DEFAULT_CONTACT);

// Google One Tap's Web client id: public (the page hands it to Google), empty = off.
// Format is checked by the admin route against @sab/shared, as for the contacts.
const GOOGLE_CLIENT_ID_FIELD = 'googleClientId';

// The public read shares the row with the bank details, so it is an allowlist.
const STOREFRONT_FIELDS = ['storeTitle', ...NOTICE_FIELDS, ...CONTACT_FIELDS, GOOGLE_CLIENT_ID_FIELD];

module.exports = {
	SETTINGS_KEY,
	DEFAULT_STORE_TITLE,
	STORE_TITLE_MAX_LENGTH,
	NOTICE_MAX_LENGTH,
	DEFAULT_NOTICES,
	NOTICE_FIELDS,
	DEFAULT_CONTACT,
	DEFAULT_PREFIX_MESSAGE,
	DEFAULT_UPDATED_BY,
	CONTACT_FIELDS,
	GOOGLE_CLIENT_ID_FIELD,
	STOREFRONT_FIELDS
};
