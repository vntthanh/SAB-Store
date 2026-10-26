const ERROR_CODES = {
	VALIDATION_ERROR: 'VALIDATION_ERROR',
	NOT_FOUND: 'NOT_FOUND',
	UNAUTHORIZED: 'UNAUTHORIZED',
	FORBIDDEN: 'FORBIDDEN',
	CONFLICT: 'CONFLICT',
	DATABASE_ERROR: 'DATABASE_ERROR',
	EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
	INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
	BAD_REQUEST: 'BAD_REQUEST',
	PAYMENT_ERROR: 'PAYMENT_ERROR',
	FILE_UPLOAD_ERROR: 'FILE_UPLOAD_ERROR',
	PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
	PRODUCT_CHANNEL_MISMATCH: 'PRODUCT_CHANNEL_MISMATCH',
	PRICE_CHANGED: 'PRICE_CHANGED',
	CART_TOO_MANY_UNITS: 'CART_TOO_MANY_UNITS',
	CART_TOO_COMPLEX: 'CART_TOO_COMPLEX',
	QUANTITY_OUT_OF_RANGE: 'QUANTITY_OUT_OF_RANGE',
	QUANTITY_OVER_MAX: 'QUANTITY_OVER_MAX',
	STOCK_ADJUSTMENT_INVALID: 'STOCK_ADJUSTMENT_INVALID',
	ORDER_PROCESSING_ERROR: 'ORDER_PROCESSING_ERROR',
	ORDER_FINAL: 'ORDER_FINAL',
	ORDER_TOTAL_CHANGED: 'ORDER_TOTAL_CHANGED',
	ORDER_CHANGED: 'ORDER_CHANGED',
	COMBO_ERROR: 'COMBO_ERROR',
	AUTH_ERROR: 'AUTH_ERROR',
	RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
	CORS_ERROR: 'CORS_ERROR',
	NO_FILE: 'NO_FILE',
	RESTORE_CONFIRMATION_REQUIRED: 'RESTORE_CONFIRMATION_REQUIRED',
	RESTORE_FORMAT_UNSUPPORTED: 'RESTORE_FORMAT_UNSUPPORTED',
	RESTORE_FILE_INVALID: 'RESTORE_FILE_INVALID',
	RESTORE_STOCK_MISMATCH: 'RESTORE_STOCK_MISMATCH',
	RESTORE_IN_PROGRESS: 'RESTORE_IN_PROGRESS',
	RESTORE_ERROR: 'RESTORE_ERROR',
	IMPORT_STOREFRONT_MISSING: 'IMPORT_STOREFRONT_MISSING',
	RESTORE_BUSY: 'RESTORE_BUSY',
	STORE_RESTORING: 'STORE_RESTORING',
	EXPORT_TOO_LARGE: 'EXPORT_TOO_LARGE',
	OTP_MAIL_UNAVAILABLE: 'OTP_MAIL_UNAVAILABLE',
	OTP_COOLDOWN: 'OTP_COOLDOWN',
	OTP_LIMIT_REACHED: 'OTP_LIMIT_REACHED',
	EMAIL_HELD_BY_CUSTOMER: 'EMAIL_HELD_BY_CUSTOMER',
	GOOGLE_EMAIL_UNVERIFIED: 'GOOGLE_EMAIL_UNVERIFIED',
	GOOGLE_SIGN_IN_UNAVAILABLE: 'GOOGLE_SIGN_IN_UNAVAILABLE',
	STOREFRONT_NOT_FOUND: 'STOREFRONT_NOT_FOUND',
	STOREFRONT_LOGIN_REQUIRED: 'STOREFRONT_LOGIN_REQUIRED',
	STOREFRONT_FORBIDDEN: 'STOREFRONT_FORBIDDEN',
	STOREFRONT_ORDER_FORBIDDEN: 'STOREFRONT_ORDER_FORBIDDEN',
	ORDER_MIXED_STOREFRONTS: 'ORDER_MIXED_STOREFRONTS',
	STOREFRONT_IN_USE: 'STOREFRONT_IN_USE',
	LAST_ACTIVE_STOREFRONT: 'LAST_ACTIVE_STOREFRONT',
	DEFAULT_STOREFRONT: 'DEFAULT_STOREFRONT',
	STOREFRONT_SLUG_TAKEN: 'STOREFRONT_SLUG_TAKEN',
	EMAIL_LIST_NOT_FOUND: 'EMAIL_LIST_NOT_FOUND',
	EMAIL_LIST_NAME_TAKEN: 'EMAIL_LIST_NAME_TAKEN',
	ACCESS_RULE_DUPLICATE: 'ACCESS_RULE_DUPLICATE',
	RULE_NOT_FOUND: 'RULE_NOT_FOUND',
	EMAIL_ENTRY_NOT_FOUND: 'EMAIL_ENTRY_NOT_FOUND',
	REFERENCE_VIOLATION: 'REFERENCE_VIOLATION'
};

const ERROR_MESSAGES = {
	[ERROR_CODES.VALIDATION_ERROR]: {
		vi: 'Dữ liệu không hợp lệ',
		en: 'Validation failed'
	},
	[ERROR_CODES.NOT_FOUND]: {
		vi: 'Không tìm thấy tài nguyên',
		en: 'Resource not found'
	},
	[ERROR_CODES.UNAUTHORIZED]: {
		vi: 'Chưa xác thực',
		en: 'Unauthorized'
	},
	[ERROR_CODES.FORBIDDEN]: {
		vi: 'Không có quyền truy cập',
		en: 'Forbidden'
	},
	[ERROR_CODES.CONFLICT]: {
		vi: 'Dữ liệu bị xung đột',
		en: 'Resource conflict'
	},
	[ERROR_CODES.DATABASE_ERROR]: {
		vi: 'Lỗi cơ sở dữ liệu',
		en: 'Database error'
	},
	[ERROR_CODES.EXTERNAL_SERVICE_ERROR]: {
		vi: 'Lỗi dịch vụ bên ngoài',
		en: 'External service error'
	},
	[ERROR_CODES.INTERNAL_SERVER_ERROR]: {
		vi: 'Lỗi máy chủ nội bộ',
		en: 'Internal server error'
	},
	[ERROR_CODES.BAD_REQUEST]: {
		vi: 'Yêu cầu không hợp lệ',
		en: 'Bad request'
	},
	[ERROR_CODES.PAYMENT_ERROR]: {
		vi: 'Lỗi xử lý thanh toán',
		en: 'Payment processing error'
	},
	[ERROR_CODES.FILE_UPLOAD_ERROR]: {
		vi: 'Lỗi tải file lên',
		en: 'File upload error'
	},
	[ERROR_CODES.PRODUCT_UNAVAILABLE]: {
		vi: 'Sản phẩm không khả dụng',
		en: 'Product unavailable'
	},
	[ERROR_CODES.PRODUCT_CHANNEL_MISMATCH]: {
		vi: 'Sản phẩm không bán ở kênh này',
		en: 'Product is not sold on this channel'
	},
	[ERROR_CODES.PRICE_CHANGED]: {
		vi: 'Giá vừa thay đổi, vui lòng xem lại giỏ hàng',
		en: 'Price changed, please review the cart'
	},
	[ERROR_CODES.CART_TOO_MANY_UNITS]: {
		vi: 'Đơn hàng có quá nhiều sản phẩm',
		en: 'Order has too many units'
	},
	[ERROR_CODES.CART_TOO_COMPLEX]: {
		vi: 'Giỏ hàng quá phức tạp để tính giá',
		en: 'Cart is too complex to price'
	},
	[ERROR_CODES.QUANTITY_OUT_OF_RANGE]: {
		vi: 'Số lượng nằm ngoài giới hạn cho phép',
		en: 'Quantity is outside the allowed range'
	},
	[ERROR_CODES.QUANTITY_OVER_MAX]: {
		vi: 'Số lượng vượt mức tối đa, cần xác nhận',
		en: 'Quantity exceeds the maximum and needs confirmation'
	},
	[ERROR_CODES.STOCK_ADJUSTMENT_INVALID]: {
		vi: 'Điều chỉnh tồn kho không hợp lệ',
		en: 'Invalid stock adjustment'
	},
	[ERROR_CODES.ORDER_PROCESSING_ERROR]: {
		vi: 'Lỗi xử lý đơn hàng',
		en: 'Order processing error'
	},
	[ERROR_CODES.ORDER_FINAL]: {
		vi: 'Đơn đã ở trạng thái cuối, chỉ sửa được ghi chú',
		en: 'Order is in a final status, only notes can be edited'
	},
	[ERROR_CODES.ORDER_TOTAL_CHANGED]: {
		vi: 'Tổng tiền sau khi sửa khác tổng tiền của đơn',
		en: 'The edited items do not add up to the order total'
	},
	[ERROR_CODES.ORDER_CHANGED]: {
		vi: 'Đơn vừa được cập nhật, vui lòng tải lại',
		en: 'The order was just updated, please reload'
	},
	[ERROR_CODES.COMBO_ERROR]: {
		vi: 'Lỗi xử lý combo',
		en: 'Combo processing error'
	},
	[ERROR_CODES.AUTH_ERROR]: {
		vi: 'Lỗi xác thực',
		en: 'Authentication error'
	},
	[ERROR_CODES.RATE_LIMIT_ERROR]: {
		vi: 'Vượt quá giới hạn yêu cầu',
		en: 'Rate limit exceeded'
	},
	[ERROR_CODES.CORS_ERROR]: {
		vi: 'Lỗi CORS',
		en: 'CORS error'
	},
	[ERROR_CODES.NO_FILE]: {
		vi: 'Chưa chọn file',
		en: 'No file uploaded'
	},
	[ERROR_CODES.RESTORE_CONFIRMATION_REQUIRED]: {
		vi: 'Cần nhập đúng cụm xác nhận để khôi phục',
		en: 'The confirmation phrase is missing or wrong'
	},
	[ERROR_CODES.RESTORE_FORMAT_UNSUPPORTED]: {
		vi: 'File này không dùng để khôi phục được. Hãy dùng chức năng Nhập Database (gộp dữ liệu), hoặc xuất một bản sao lưu mới rồi khôi phục từ đó',
		en: 'This file is not a restorable backup; use the merge import instead'
	},
	[ERROR_CODES.RESTORE_FILE_INVALID]: {
		vi: 'File sao lưu không hợp lệ, chưa có dữ liệu nào bị thay đổi',
		en: 'The backup file is invalid; nothing was changed'
	},
	[ERROR_CODES.RESTORE_STOCK_MISMATCH]: {
		vi: 'Tồn kho trong file không khớp với lịch sử nhập xuất, chưa có dữ liệu nào bị thay đổi',
		en: 'Stock in the file does not match its ledger; nothing was changed'
	},
	[ERROR_CODES.RESTORE_IN_PROGRESS]: {
		vi: 'Một lượt khôi phục khác đang chạy, vui lòng chờ',
		en: 'Another restore is already running'
	},
	[ERROR_CODES.RESTORE_ERROR]: {
		vi: 'Khôi phục thất bại, dữ liệu hiện tại được giữ nguyên',
		en: 'Restore failed; current data is unchanged'
	},
	[ERROR_CODES.IMPORT_STOREFRONT_MISSING]: {
		vi: 'File nhắc tới cửa hàng chưa có trong hệ thống này. Hãy dùng "Khôi phục" để nạp lại cửa hàng trước; chưa có dữ liệu nào bị thay đổi',
		en: 'The file names a storefront this system lacks. Use Restore to load the storefront first; nothing was changed'
	},
	[ERROR_CODES.RESTORE_BUSY]: {
		vi: 'Hệ thống còn thao tác ghi đang chạy nên chưa khôi phục được, vui lòng thử lại sau ít phút',
		en: 'Writes are still in flight; restore did not start'
	},
	[ERROR_CODES.STORE_RESTORING]: {
		vi: 'Hệ thống đang khôi phục dữ liệu, vui lòng thử lại sau ít phút',
		en: 'The store is being restored, please retry in a few minutes'
	},
	[ERROR_CODES.EXPORT_TOO_LARGE]: {
		vi: 'Bản sao lưu vượt quá giới hạn 10MB nên không thể khôi phục lại được, vì vậy không tạo file. Hãy liên hệ người quản trị hệ thống',
		en: 'The backup exceeds the 10MB restore limit, so it was not produced'
	},
	[ERROR_CODES.OTP_MAIL_UNAVAILABLE]: {
		vi: 'Hiện chưa gửi được mã qua email, vui lòng đăng nhập bằng Google',
		en: 'Sign-in codes by email are unavailable right now'
	},
	[ERROR_CODES.OTP_COOLDOWN]: {
		vi: 'Vui lòng đợi 60 giây trước khi gửi lại mã',
		en: 'Please wait 60 seconds before requesting another code'
	},
	[ERROR_CODES.OTP_LIMIT_REACHED]: {
		vi: 'Đã gửi quá nhiều mã, vui lòng thử lại sau',
		en: 'Too many codes were sent, please try again later'
	},
	[ERROR_CODES.EMAIL_HELD_BY_CUSTOMER]: {
		vi: 'Email đã thuộc một tài khoản khách hàng',
		en: 'This email already belongs to a customer account'
	},
	[ERROR_CODES.GOOGLE_EMAIL_UNVERIFIED]: {
		vi: 'Email của tài khoản Google này chưa được xác minh',
		en: 'The Google account email is not verified'
	},
	[ERROR_CODES.GOOGLE_SIGN_IN_UNAVAILABLE]: {
		vi: 'Đăng nhập bằng Google chưa được bật',
		en: 'Google sign-in is not configured'
	},
	[ERROR_CODES.STOREFRONT_NOT_FOUND]: {
		vi: 'Không tìm thấy gian hàng',
		en: 'Storefront not found'
	},
	[ERROR_CODES.STOREFRONT_LOGIN_REQUIRED]: {
		vi: 'Vui lòng đăng nhập để xem gian hàng này',
		en: 'Please sign in to view this storefront'
	},
	[ERROR_CODES.STOREFRONT_FORBIDDEN]: {
		vi: 'Tài khoản của bạn chưa được cấp quyền vào gian hàng này',
		en: 'Your account has no access to this storefront'
	},
	[ERROR_CODES.STOREFRONT_ORDER_FORBIDDEN]: {
		vi: 'Email của bạn không nằm trong danh sách được đặt hàng ở gian hàng này',
		en: 'Your email is not allowed to order in this storefront'
	},
	[ERROR_CODES.ORDER_MIXED_STOREFRONTS]: {
		vi: 'Đơn hàng chỉ được gồm sản phẩm của một gian hàng',
		en: 'An order may only contain products of one storefront'
	},
	[ERROR_CODES.STOREFRONT_IN_USE]: {
		vi: 'Gian hàng còn sản phẩm, combo hoặc đơn hàng nên không thể xoá; hãy tắt gian hàng thay vì xoá',
		en: 'The storefront still has products, combos or orders; deactivate it instead'
	},
	[ERROR_CODES.LAST_ACTIVE_STOREFRONT]: {
		vi: 'Phải còn ít nhất một gian hàng đang hoạt động',
		en: 'At least one storefront must stay active'
	},
	[ERROR_CODES.DEFAULT_STOREFRONT]: {
		vi: 'Không thể xoá gian hàng mặc định',
		en: 'The default storefront cannot be deleted'
	},
	[ERROR_CODES.STOREFRONT_SLUG_TAKEN]: {
		vi: 'Đường dẫn gian hàng đã được dùng',
		en: 'This storefront slug is already taken'
	},
	[ERROR_CODES.EMAIL_LIST_NOT_FOUND]: {
		vi: 'Không tìm thấy danh sách email',
		en: 'Email list not found'
	},
	[ERROR_CODES.EMAIL_LIST_NAME_TAKEN]: {
		vi: 'Tên danh sách email đã được dùng',
		en: 'This email list name is already taken'
	},
	[ERROR_CODES.ACCESS_RULE_DUPLICATE]: {
		vi: 'Quy tắc truy cập này đã tồn tại',
		en: 'This access rule already exists'
	},
	[ERROR_CODES.RULE_NOT_FOUND]: {
		vi: 'Không tìm thấy quy tắc',
		en: 'Access rule not found'
	},
	[ERROR_CODES.EMAIL_ENTRY_NOT_FOUND]: {
		vi: 'Không tìm thấy email trong danh sách',
		en: 'Email not found in the list'
	},
	[ERROR_CODES.REFERENCE_VIOLATION]: {
		vi: 'Bản ghi được tham chiếu không còn tồn tại',
		en: 'A referenced record no longer exists'
	}
};

const HTTP_STATUS = {
	OK: 200,
	CREATED: 201,
	NO_CONTENT: 204,
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	UNPROCESSABLE_ENTITY: 422,
	TOO_MANY_REQUESTS: 429,
	INTERNAL_SERVER_ERROR: 500,
	BAD_GATEWAY: 502,
	SERVICE_UNAVAILABLE: 503,
	PAYLOAD_TOO_LARGE: 413
};

const ERROR_CODE_TO_HTTP_STATUS = {
	[ERROR_CODES.VALIDATION_ERROR]: HTTP_STATUS.UNPROCESSABLE_ENTITY,
	[ERROR_CODES.NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
	[ERROR_CODES.UNAUTHORIZED]: HTTP_STATUS.UNAUTHORIZED,
	[ERROR_CODES.FORBIDDEN]: HTTP_STATUS.FORBIDDEN,
	[ERROR_CODES.CONFLICT]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.DATABASE_ERROR]: HTTP_STATUS.INTERNAL_SERVER_ERROR,
	[ERROR_CODES.EXTERNAL_SERVICE_ERROR]: HTTP_STATUS.BAD_GATEWAY,
	[ERROR_CODES.INTERNAL_SERVER_ERROR]: HTTP_STATUS.INTERNAL_SERVER_ERROR,
	[ERROR_CODES.BAD_REQUEST]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.PAYMENT_ERROR]: HTTP_STATUS.UNPROCESSABLE_ENTITY,
	[ERROR_CODES.FILE_UPLOAD_ERROR]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.PRODUCT_UNAVAILABLE]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.PRODUCT_CHANNEL_MISMATCH]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.PRICE_CHANGED]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.CART_TOO_MANY_UNITS]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.CART_TOO_COMPLEX]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.QUANTITY_OUT_OF_RANGE]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.QUANTITY_OVER_MAX]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.STOCK_ADJUSTMENT_INVALID]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.ORDER_PROCESSING_ERROR]: HTTP_STATUS.UNPROCESSABLE_ENTITY,
	[ERROR_CODES.ORDER_FINAL]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.ORDER_TOTAL_CHANGED]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.ORDER_CHANGED]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.COMBO_ERROR]: HTTP_STATUS.UNPROCESSABLE_ENTITY,
	[ERROR_CODES.AUTH_ERROR]: HTTP_STATUS.UNAUTHORIZED,
	[ERROR_CODES.RATE_LIMIT_ERROR]: HTTP_STATUS.TOO_MANY_REQUESTS,
	[ERROR_CODES.CORS_ERROR]: HTTP_STATUS.FORBIDDEN,
	[ERROR_CODES.NO_FILE]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.RESTORE_CONFIRMATION_REQUIRED]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.RESTORE_FORMAT_UNSUPPORTED]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.RESTORE_FILE_INVALID]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.RESTORE_STOCK_MISMATCH]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.RESTORE_IN_PROGRESS]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.RESTORE_ERROR]: HTTP_STATUS.INTERNAL_SERVER_ERROR,
	[ERROR_CODES.IMPORT_STOREFRONT_MISSING]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.RESTORE_BUSY]: HTTP_STATUS.SERVICE_UNAVAILABLE,
	[ERROR_CODES.STORE_RESTORING]: HTTP_STATUS.SERVICE_UNAVAILABLE,
	[ERROR_CODES.EXPORT_TOO_LARGE]: HTTP_STATUS.PAYLOAD_TOO_LARGE,
	[ERROR_CODES.OTP_MAIL_UNAVAILABLE]: HTTP_STATUS.SERVICE_UNAVAILABLE,
	[ERROR_CODES.OTP_COOLDOWN]: HTTP_STATUS.TOO_MANY_REQUESTS,
	[ERROR_CODES.OTP_LIMIT_REACHED]: HTTP_STATUS.TOO_MANY_REQUESTS,
	[ERROR_CODES.EMAIL_HELD_BY_CUSTOMER]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.GOOGLE_EMAIL_UNVERIFIED]: HTTP_STATUS.FORBIDDEN,
	[ERROR_CODES.GOOGLE_SIGN_IN_UNAVAILABLE]: HTTP_STATUS.SERVICE_UNAVAILABLE,
	[ERROR_CODES.STOREFRONT_NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
	[ERROR_CODES.STOREFRONT_LOGIN_REQUIRED]: HTTP_STATUS.UNAUTHORIZED,
	[ERROR_CODES.STOREFRONT_FORBIDDEN]: HTTP_STATUS.FORBIDDEN,
	[ERROR_CODES.STOREFRONT_ORDER_FORBIDDEN]: HTTP_STATUS.FORBIDDEN,
	[ERROR_CODES.ORDER_MIXED_STOREFRONTS]: HTTP_STATUS.BAD_REQUEST,
	[ERROR_CODES.STOREFRONT_IN_USE]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.LAST_ACTIVE_STOREFRONT]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.DEFAULT_STOREFRONT]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.STOREFRONT_SLUG_TAKEN]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.EMAIL_LIST_NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
	[ERROR_CODES.EMAIL_LIST_NAME_TAKEN]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.ACCESS_RULE_DUPLICATE]: HTTP_STATUS.CONFLICT,
	[ERROR_CODES.RULE_NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
	[ERROR_CODES.EMAIL_ENTRY_NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
	[ERROR_CODES.REFERENCE_VIOLATION]: HTTP_STATUS.CONFLICT
};

module.exports = {
	ERROR_CODES,
	ERROR_MESSAGES,
	HTTP_STATUS,
	ERROR_CODE_TO_HTTP_STATUS
};
