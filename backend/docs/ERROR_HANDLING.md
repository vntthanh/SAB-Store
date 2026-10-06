# Error Handling & Logging Documentation

## Overview

Backend đã được cải thiện với hệ thống error logging và error response toàn diện, giúp dễ dàng debug và theo dõi lỗi trong production.

## Cấu trúc

### 1. Error Codes (`constants/errorCodes.js`)

Định nghĩa các mã lỗi chuẩn và HTTP status codes tương ứng:

```javascript
const { ERROR_CODES, HTTP_STATUS } = require('./constants/errorCodes');

// Ví dụ các error codes
ERROR_CODES.VALIDATION_ERROR
ERROR_CODES.NOT_FOUND
ERROR_CODES.UNAUTHORIZED
ERROR_CODES.DATABASE_ERROR
ERROR_CODES.PRODUCT_UNAVAILABLE
ERROR_CODES.ORDER_PROCESSING_ERROR
```

### 2. Error Logger (`utils/errorLogger.js`)

Class quản lý structured logging với context và metadata đầy đủ.

#### Sử dụng

```javascript
const ErrorLogger = require('./utils/errorLogger');

// Log thông tin thông thường
ErrorLogger.logInfo('[ORDER] Order created', { orderId, orderCode });

// Log debug (chỉ hiện ở development)
ErrorLogger.logDebug('[PRODUCT] Processing items', { count: items.length });

// Log warning
ErrorLogger.logWarning('[PAYMENT] QR generation slow', { duration: 2000 });

// Log lỗi route với full context
ErrorLogger.logRoute('/api/orders', error, req);

// Log lỗi database
ErrorLogger.logDatabase('find', error, { collection: 'orders', query });

// Log lỗi external service
ErrorLogger.logExternalService('PaymentQR', error, { 
	endpoint: '/generate',
	statusCode: 500 
});
```

#### Features

- **Structured Logging**: JSON format với timestamp, context, và metadata
- **Request Context**: Tự động log IP, user agent, method, URL, params
- **Sensitive Data Protection**: Tự động ẩn password, token, apiKey
- **Environment-aware**: Debug logs chỉ hiện ở development

### 3. Error Response (`utils/errorResponse.js`)

Class tạo và format error response chuẩn cho client.

#### Sử dụng trong Routes

```javascript
const { ErrorResponse } = require('../utils/errorResponse');

// Express 4 không bắt lỗi của handler async: bọc try/catch và chuyển lỗi cho next()
router.post('/orders', async (req, res, next) => {
	try {
		// Validation error
		if (!items || items.length === 0) {
			throw ErrorResponse.validationError('Danh sách sản phẩm không hợp lệ', {
				field: 'items',
				received: items
			});
		}

		// Not found error
		if (!product) {
			throw ErrorResponse.notFoundError('Sản phẩm', {
				productId: req.params.id
			});
		}

		// Product unavailable error
		throw ErrorResponse.productUnavailableError('Sản phẩm X', {
			productId: 'xxx',
			stockQuantity: 0
		});

		// Order processing error
		throw ErrorResponse.orderProcessingError('Không thể tạo mã đơn hàng', {
			attempts: 10
		});

		// Bad request
		throw ErrorResponse.badRequestError('Tham số không hợp lệ', {
			param: 'quantity',
			value: -1
		});
	} catch (error) {
		next(error);
	}
});
```

#### Error Response Format

```json
{
	"success": false,
	"error": {
		"code": "VALIDATION_ERROR",
		"message": "Danh sách sản phẩm không hợp lệ",
		"timestamp": "2025-11-21T15:30:45.123Z",
		"details": {
			"field": "items",
			"received": []
		}
	}
}
```

#### Development Mode Response (bổ sung thêm)

```json
{
	"success": false,
	"error": {
		"code": "VALIDATION_ERROR",
		"message": "Danh sách sản phẩm không hợp lệ",
		"timestamp": "2025-11-21T15:30:45.123Z",
		"details": {
			"field": "items",
			"received": []
		},
		"debug": {
			"stack": "Error: ...\n    at ...",
			"name": "ValidationError",
			"statusCode": 422,
			"isOperational": true,
			"request": {
				"method": "POST",
				"url": "/api/orders",
				"params": {},
				"query": {},
				"body": { "items": [] }
			}
		}
	}
}
```

### 4. Global Error Middleware (`server.js`)

Global error handler tự động xử lý:

- Mongoose validation errors
- Cast errors (invalid ObjectId)
- Duplicate key errors
- CORS errors
- Operational vs system errors

```javascript
app.use((err, req, res, next) => {
	// Tự động detect và convert Mongoose errors
	// Tự động log với full context
	// Tự động format response cho client
	ErrorResponse.sendErrorResponse(res, error, req);
});
```

### 5. Database Error Handling (`lib/database.js`)

Database connection với improved logging:

```javascript
const ErrorLogger = require('../utils/errorLogger');

// Connection với structured logging
await connectDB();
// [INFO] Connecting to MongoDB... { host: 'xxx' }
// [OK] MongoDB connected successfully { readyState: 1 }

// Error events
mongoose.connection.on('error', (err) => {
	ErrorLogger.logDatabase('connection_error', err, { readyState });
});

// Reconnection events
mongoose.connection.on('reconnected', () => {
	ErrorLogger.logInfo('MongoDB reconnected', { readyState });
});
```

## Best Practices

### 1. Chuyển lỗi của handler async cho next()

```javascript
// [OK] CORRECT - Express 4 không tự bắt lỗi của handler async
router.get('/:id', async (req, res, next) => {
	try {
		// Code có thể throw error
	} catch (error) {
		next(error);
	}
});

// [ERROR] WRONG - Handler async không try/catch: lỗi thành unhandled rejection
router.get('/:id', async (req, res) => {
	// Code có thể throw error
});
```

### 2. Throw error thay vì return response

```javascript
// [OK] CORRECT - Để middleware xử lý
if (!product) {
	throw ErrorResponse.notFoundError('Sản phẩm', { productId });
}

// [ERROR] WRONG - Response không chuẩn
if (!product) {
	return res.status(404).json({ message: 'Not found' });
}
```

### 3. Luôn provide context trong error

```javascript
// [OK] CORRECT - Có context để debug
throw ErrorResponse.productUnavailableError('Sản phẩm A', {
	productId: 'xxx',
	requestedQuantity: 5,
	availableQuantity: 2
});

// [ERROR] WRONG - Thiếu context
throw ErrorResponse.productUnavailableError('Sản phẩm A');
```

### 4. Sử dụng ErrorLogger cho non-error logs

```javascript
// [OK] CORRECT - Structured logging
ErrorLogger.logInfo('[ORDER] Order created', { orderId, totalAmount });
ErrorLogger.logDebug('[CART] Items processed', { itemCount });

// [ERROR] WRONG - Console logs không có structure
console.log('Order created', orderId);
console.log('Items:', items);
```

### 5. Log external service errors

```javascript
// [OK] CORRECT
	try {
		await sendEmail(data);
	} catch (error) {
		ErrorLogger.logExternalService('EmailService', error, {
			endpoint: '/send',
			recipient: email
		});
	}

// [ERROR] WRONG
	try {
		await sendEmail(data);
	} catch (error) {
		console.error('Email failed:', error.message);
	}
```

## Testing Error Responses

### Ví dụ test với curl

```bash
# Validation error
curl -X POST http://localhost:5000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"items": []}'

# Response:
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Danh sách sản phẩm không hợp lệ",
    "timestamp": "2025-11-21T15:30:45.123Z",
    "details": {
      "field": "items",
      "received": []
    }
  }
	}

# Not found error
curl http://localhost:5000/api/products/invalid-id

# Response:
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "ID không hợp lệ: invalid-id",
    "timestamp": "2025-11-21T15:30:45.123Z"
  }
	}
```

## Error Codes Reference

| Error Code | HTTP Status | Mô tả |
|-----------|-------------|-------|
| `VALIDATION_ERROR` | 422 | Dữ liệu không hợp lệ |
| `NOT_FOUND` | 404 | Không tìm thấy tài nguyên |
| `UNAUTHORIZED` | 401 | Chưa xác thực |
| `FORBIDDEN` | 403 | Không có quyền truy cập |
| `CONFLICT` | 409 | Dữ liệu bị xung đột |
| `DATABASE_ERROR` | 500 | Lỗi cơ sở dữ liệu |
| `EXTERNAL_SERVICE_ERROR` | 502 | Lỗi dịch vụ bên ngoài |
| `BAD_REQUEST` | 400 | Yêu cầu không hợp lệ |
| `PRODUCT_UNAVAILABLE` | 409 | Sản phẩm không khả dụng |
| `ORDER_PROCESSING_ERROR` | 422 | Lỗi xử lý đơn hàng |
| `COMBO_ERROR` | 422 | Lỗi xử lý combo |
| `RATE_LIMIT_ERROR` | 429 | Vượt quá giới hạn yêu cầu |
| `CORS_ERROR` | 403 | Lỗi CORS |

## Lợi ích

### Cho Developer

- **Dễ debug**: Có full context, stack trace, request info
- **Consistent**: Tất cả errors đều có cùng format
- **Type-safe**: Sử dụng error codes constants
- **Less boilerplate**: Không cần viết try-catch ở mỗi route

### Cho Client/Frontend

- **Predictable**: Response format luôn nhất quán
- **Informative**: Có error code để handle logic
- **Detailed**: Có details object cho validation errors
- **i18n ready**: Có error messages bằng tiếng Việt

### Cho Production

- **Structured logs**: Dễ parse và analyze
- **Sensitive data protection**: Tự động ẩn password, token
- **Environment-aware**: Production ẩn stack trace
- **Performance**: Không log debug ở production

## Migration từ old code

### Before

```javascript
router.post('/orders', async (req, res) => {
		try {
			if (!items) {
				return res.status(400).json({
					success: false,
					message: 'Invalid items'
				});
			}
			// ...
		} catch (error) {
			console.error('Error:', error);
			res.status(500).json({
				success: false,
				message: 'Server error'
			});
		}
});
```

### After

```javascript
const { ErrorResponse } = require('../utils/errorResponse');
const ErrorLogger = require('../utils/errorLogger');

router.post('/orders', async (req, res, next) => {
	try {
		if (!items) {
			throw ErrorResponse.validationError('Danh sách sản phẩm không hợp lệ', {
				field: 'items'
			});
		}
		
		ErrorLogger.logInfo('[ORDER] Order created', { orderId });
		// ...
	} catch (error) {
		next(error);
	}
});
```

## Monitoring & Analytics

Logs có thể được export và phân tích bằng các tools:

- **ELK Stack**: Elasticsearch + Logstash + Kibana
- **CloudWatch**: AWS CloudWatch Logs
- **Datadog**: Application monitoring
- **Sentry**: Error tracking and alerting

Format JSON của logs giúp dễ dàng parse và analyze.
