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
	CORS_ERROR: 'CORS_ERROR'
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
	SERVICE_UNAVAILABLE: 503
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
	[ERROR_CODES.CORS_ERROR]: HTTP_STATUS.FORBIDDEN
};

module.exports = {
	ERROR_CODES,
	ERROR_MESSAGES,
	HTTP_STATUS,
	ERROR_CODE_TO_HTTP_STATUS
};
