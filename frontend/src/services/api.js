import axios from 'axios';
import { authClient } from '../lib/auth-client';
import { canUseAdmin, canUseSeller } from '../lib/auth-flow';

// Same-origin relative path: frontend nginx proxies /api/ to the backend,
// so the bundle never needs to know the domain (AD-3).
const api = axios.create({
	baseURL: '/api',
	timeout: 10000,
	headers: {
		'Content-Type': 'application/json',
	},
	withCredentials: true, // Important for better-auth session cookies
});

const STOREFRONT_LOGIN_REQUIRED = 'STOREFRONT_LOGIN_REQUIRED';

// Request interceptor to add session cookies
api.interceptors.request.use(
	async (config) => {
		// Better-auth handles session via cookies automatically
		// No manual token handling needed
		return config;
	},
	(error) => {
		return Promise.reject(error);
	}
);

// Response interceptor to handle common errors
api.interceptors.response.use(
	(response) => {
		return response;
	},
	async (error) => {
		// A private storefront answers 401 to an anonymous viewer; the page shows its sign-in
		// panel, so the session is not "expired" and must not be signed out or redirected.
		if (error.response?.status === 401 && error.response?.data?.code !== STOREFRONT_LOGIN_REQUIRED) {
			// Session expired or invalid - sign out user
			try {
				await authClient.signOut();

				// Redirect to unified login page
				window.location.href = '/login';
			} catch (signOutError) {
				console.error('Error signing out:', signOutError);
			}
		}
		return Promise.reject(error);
	}
);

// Keeps the server's error `code` and HTTP status on the thrown Error so callers
// can branch on them (PRICE_CHANGED) instead of parsing the message.
const toApiError = (error, fallback) => {
	const apiError = new Error(error.response?.data?.message || fallback);
	apiError.status = error.response?.status;
	apiError.code = error.response?.data?.code;
	apiError.details = error.response?.data?.details;
	// Validation 400s: [{ field, message }] so forms can show each reason under its input.
	apiError.fieldErrors = error.response?.data?.errors;
	// Storefront access errors (401/403) name the storefront so the page can offer sign-in for it.
	apiError.storefront = error.response?.data?.storefront;
	return apiError;
};

export const PRICE_CHANGED = 'PRICE_CHANGED';

// Product Services
export const productService = {
	// Public detail by code; a 404 surfaces as err.status === 404 so pages can render NotFoundPage.
	getByCode: async (code) => {
		try {
			const response = await api.get(`/products/by-code/${encodeURIComponent(code)}`);
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi lấy thông tin sản phẩm');
		}
	},

	// Get all products
	getProducts: async (params = {}) => {
		try {
			const response = await api.get('/products', { params });
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy danh sách sản phẩm');
		}
	},

	// Get products for direct sales (filters by isActive instead of available)
	getDirectSalesProducts: async (params = {}) => {
		try {
			const response = await api.get('/products/direct-sales', { params });
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy danh sách sản phẩm bán trực tiếp');
		}
	},

	// Get single product
	getProduct: async (id) => {
		try {
			const response = await api.get(`/products/${id}`);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy thông tin sản phẩm');
		}
	},

	// Get product categories
	getCategories: async () => {
		try {
			const response = await api.get('/products/categories/list');
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy danh sách danh mục');
		}
	}
};

// Order Services
export const orderService = {
	// Create new order
	createOrder: async (orderData) => {
		try {
			const response = await api.post('/orders', orderData);
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi tạo đơn hàng');
		}
	},

	// Get order by code (for tracking)
	getOrderByCode: async (orderCode) => {
		try {
			const response = await api.get(`/orders/${orderCode}`);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Không tìm thấy đơn hàng');
		}
	}
};

// Admin Services
export const adminService = {
	// Check if admin is logged in
	isLoggedIn: async () => {
		try {
			const { data: session } = await authClient.getSession();
			return Boolean(session?.user) && canUseAdmin(session.user);
		} catch (error) {
			return false;
		}
	},

	// Admin logout
	logout: async () => {
		try {
			await authClient.signOut();
			return { success: true };
		} catch (error) {
			console.error('Logout error:', error);
			throw error;
		}
	},

	// Admins use the seller route on purpose: it changes the caller's own password and
	// admits admins; /api/admin has no change-password route.
	changePassword: async (currentPassword, newPassword) => {
		try {
			const response = await api.post('/seller/change-password', {
				currentPassword,
				newPassword
			});
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi đổi mật khẩu');
		}
	},

	// Get dashboard statistics
	getDashboardStats: async () => {
		try {
			const response = await api.get('/admin/dashboard/stats');
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy thống kê');
		}
	},

	// Get all orders (admin)
	getOrders: async (params = {}) => {
		try {
			const response = await api.get('/admin/orders', { params });
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy danh sách đơn hàng');
		}
	},

	// Get single order (admin)
	getOrder: async (id) => {
		try {
			const response = await api.get(`/admin/orders/${id}`);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy thông tin đơn hàng');
		}
	},

	// Update order status
	updateOrderStatus: async (id, updateData) => {
		try {
			// Use appropriate endpoint based on current user type
			const isSellerRoute = window.location.pathname.startsWith('/seller');
			const endpoint = isSellerRoute
				? `/seller/orders/${id}/status`
				: `/admin/orders/${id}`;

			const response = await api.put(endpoint, updateData);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi cập nhật đơn hàng');
		}
	},

	// Edit customer/internal notes (allowed in every status, including final ones)
	updateOrderNotes: async (id, data) => {
		try {
			const response = await api.patch(`/admin/orders/${id}/notes`, data);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lưu ghi chú');
		}
	},

	// Replace an order's product lines; the server keeps the total unchanged.
	// Errors carry `code`/`details` (ORDER_TOTAL_CHANGED, ORDER_CHANGED, ORDER_FINAL).
	updateOrderItems: async (id, data) => {
		try {
			const response = await api.put(`/admin/orders/${id}/items`, data);
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi sửa sản phẩm trong đơn hàng');
		}
	},

	// Product management
	// One page of `{ success, data, meta }`; page and limit are optional.
	getProducts: async (params = {}) => {
		try {
			const response = await api.get('/admin/products', { params });
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy danh sách sản phẩm');
		}
	},

	createProduct: async (productData) => {
		try {
			const response = await api.post('/admin/products', productData);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi tạo sản phẩm');
		}
	},

	updateProduct: async (id, productData) => {
		try {
			const response = await api.put(`/admin/products/${id}`, productData);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi cập nhật sản phẩm');
		}
	},

	deleteProduct: async (id) => {
		try {
			const response = await api.delete(`/admin/products/${id}`);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi xóa sản phẩm');
		}
	},

	// Export orders to Excel
	exportOrders: async (params = {}) => {
		try {
			const response = await api.get('/admin/orders/export/excel', {
				params,
				responseType: 'blob'
			});

			// Create blob URL and trigger download
			const blob = new Blob([response.data], {
				type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
			});

			const url = window.URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `don-hang-${new Date().toISOString().split('T')[0]}.xlsx`;
			document.body.appendChild(a);
			a.click();
			window.URL.revokeObjectURL(url);
			document.body.removeChild(a);

			return { success: true, message: 'Xuất file Excel thành công' };
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi xuất file Excel');
		}
	},

	// Delete all orders (admin only - DANGEROUS)
	deleteAllOrders: async () => {
		try {
			const response = await api.delete('/admin/orders');
			return response.data;
		} catch (error) {
			console.error('API Error - deleteAllOrders:', error.response?.data || error.message);
			throw new Error(error.response?.data?.message || 'Lỗi khi xóa toàn bộ đơn hàng');
		}
	},

	// Upload image
	uploadImage: async (imageFile) => {
		try {
			const formData = new FormData();
			formData.append('image', imageFile);

			const response = await api.post('/upload/product-image', formData, {
				headers: {
					'Content-Type': 'multipart/form-data',
				},
				timeout: 30000, // 30 seconds for image upload
			});

			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi upload hình ảnh');
		}
	},

	// Combo management
	getCombos: async (params = {}) => {
		try {
			const response = await api.get('/combos', { params });
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy danh sách combo');
		}
	},

	getCombo: async (id) => {
		try {
			const response = await api.get(`/combos/${id}`);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy thông tin combo');
		}
	},

	createCombo: async (comboData) => {
		try {
			const response = await api.post('/combos', comboData);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi tạo combo');
		}
	},

	updateCombo: async (id, comboData) => {
		try {
			const response = await api.put(`/combos/${id}`, comboData);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi cập nhật combo');
		}
	},

	deleteCombo: async (id) => {
		try {
			const response = await api.delete(`/combos/${id}`);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi xóa combo');
		}
	},

	getProductCategories: async () => {
		try {
			const response = await api.get('/products/categories/list');
			return {
				success: response.data.success,
				data: {
					categories: response.data.data // Map the response correctly
				}
			};
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy danh sách danh mục');
		}
	}
};

// Seller Services
export const sellerService = {
	// Check if seller is logged in
	isLoggedIn: async () => {
		try {
			const { data: session } = await authClient.getSession();
			return Boolean(session?.user) && canUseSeller(session.user);
		} catch (error) {
			return false;
		}
	},

	// Seller logout
	logout: async () => {
		try {
			await authClient.signOut();
			return { success: true };
		} catch (error) {
			console.error('Logout error:', error);
			throw error;
		}
	},

	// Change password
	changePassword: async (currentPassword, newPassword) => {
		try {
			const response = await api.post('/seller/change-password', {
				currentPassword,
				newPassword
			});
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi đổi mật khẩu');
		}
	},

	// Get dashboard statistics
	getDashboardStats: async () => {
		try {
			const response = await api.get('/seller/dashboard/stats');
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy thống kê');
		}
	},

	// Get all orders (seller)
	getOrders: async (params = {}) => {
		try {
			const response = await api.get('/seller/orders', { params });
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy danh sách đơn hàng');
		}
	},

	// Get single order (seller)
	getOrder: async (id) => {
		try {
			const response = await api.get(`/seller/orders/${id}`);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy thông tin đơn hàng');
		}
	},

	// Update order status
	updateOrderStatus: async (id, updateData) => {
		try {
			const response = await api.put(`/seller/orders/${id}/status`, updateData);
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi cập nhật đơn hàng');
		}
	},

	// Create direct sale order
	createDirectOrder: async (orderData) => {
		try {
			const response = await api.post('/seller/orders/direct', orderData);
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi tạo đơn hàng trực tiếp');
		}
	}
};

// Utility function to format currency
export const formatCurrency = (amount) => {
	return new Intl.NumberFormat('vi-VN', {
		style: 'currency',
		currency: 'VND'
	}).format(amount);
};

// Utility function to format date
export const formatDate = (date) => {
	return new Intl.DateTimeFormat('vi-VN', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	}).format(new Date(date));
};

// Status text mapping
export const getStatusText = (status) => {
	const statusMap = {
		'confirmed': 'Đã xác nhận',
		'paid': 'Đã thanh toán',
		'delivered': 'Đã giao hàng',
		'cancelled': 'Đã hủy'
	};
	return statusMap[status] || status;
};

// Status color mapping
export const getStatusColor = (status) => {
	const colorMap = {
		'confirmed': 'bg-primary-100 text-primary-800',
		'paid': 'bg-warning-100 text-warning-800',
		'delivered': 'bg-success-100 text-success-800',
		'cancelled': 'bg-danger-100 text-danger-800'
	};
	return colorMap[status] || 'bg-gray-100 text-gray-800';
};

// Database Management Services (Admin only)
export const databaseService = {
	// Export entire database
	exportDatabase: async () => {
		try {
			const response = await api.get('/admin/database/export', {
				responseType: 'blob', // Important for file download
			});

			// Create download link
			const url = window.URL.createObjectURL(new Blob([response.data]));
			const link = document.createElement('a');
			link.href = url;

			// Extract filename from response headers or use default
			const contentDisposition = response.headers['content-disposition'];
			let filename = 'database-export.json';
			if (contentDisposition) {
				const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
				if (filenameMatch) {
					filename = filenameMatch[1];
				}
			}

			link.download = filename;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			window.URL.revokeObjectURL(url);

			return { success: true, message: 'Database exported successfully' };
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi xuất database');
		}
	},

	// Import database from file
	importDatabase: async (file) => {
		try {
			const formData = new FormData();
			formData.append('dataFile', file);

			const response = await api.post('/admin/database/import', formData, {
				headers: {
					'Content-Type': 'multipart/form-data',
				},
				timeout: 60000, // 60 seconds for large files
			});

			return response.data;
		} catch (error) {
			if (error.code === 'ECONNABORTED') {
				throw new Error('Import timeout - file quá lớn hoặc quá trình import mất quá nhiều thời gian');
			}
			throw new Error(error.response?.data?.message || 'Lỗi khi import database');
		}
	},

	// Get database statistics
	getDatabaseStats: async () => {
		try {
			const response = await api.get('/admin/database/stats');
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy thống kê database');
		}
	}
};

// Combo Services
export const comboService = {
	getByCode: async (code) => {
		try {
			const response = await api.get(`/combos/by-code/${encodeURIComponent(code)}`);
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi lấy thông tin combo');
		}
	},

	// Get active combos
	getActiveCombos: async () => {
		try {
			const response = await api.get('/combos/active');
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi lấy danh sách combo');
		}
	},

	// Server-computed price of a cart: the same engine that prices the order, so
	// `data.totalAmount` is what must be sent back as `expectedTotal`.
	// `channel` is omitted when unset so the server applies its own default (online).
	calculatePricing: async (items, { channel } = {}) => {
		try {
			const body = channel ? { items, channel } : { items };
			const response = await api.post('/combos/pricing', body);
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi tính toán giá tối ưu');
		}
	}
};

// These mirror backend/models/Settings.js; the server is the authority.
// The default is used only when the title cannot be fetched and none was seen before.
export const DEFAULT_STORE_TITLE = 'SAB Store';
export const STORE_TITLE_MAX_LENGTH = 60;
export const NOTICE_MAX_LENGTH = 5000;

// One request per page load: the header mounts on every route, and these
// settings only change when an admin edits them.
let publicSettingsRequest = null;

export const settingsService = {
	getPublicSettings: () => {
		if (!publicSettingsRequest) {
			publicSettingsRequest = api.get('/settings')
				.then((response) => response.data.data)
				.catch((error) => {
					publicSettingsRequest = null;
					throw error;
				});
		}
		return publicSettingsRequest;
	},

	// Called after an admin saves, so pages rendered afterwards get the new settings without a reload.
	clearPublicSettingsCache: () => {
		publicSettingsRequest = null;
	}
};

// Admin SMTP settings. The stored password never comes back (`hasPassword` only), and `pass`
// is omitted from a PUT to keep the stored one.
export const mailSettingsService = {
	get: async () => {
		try {
			const response = await api.get('/admin/settings/mail');
			return response.data.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi tải cấu hình email');
		}
	},

	update: async (payload) => {
		try {
			const response = await api.put('/admin/settings/mail', payload);
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi cập nhật cấu hình email');
		}
	},

	sendTest: async (to) => {
		try {
			// Longer than the server's SMTP timeouts (10 s connect + 10 s greeting + 20 s socket),
			// so the admin sees the server's reason instead of a client-side abort.
			const response = await api.post('/admin/settings/mail/test', { to }, { timeout: 45000 });
			return response.data;
		} catch (error) {
			throw toApiError(error, 'Lỗi khi gửi email thử');
		}
	}
};

// Public storefront tabs. A private storefront the viewer may not open rejects with
// `code` (STOREFRONT_LOGIN_REQUIRED / STOREFRONT_FORBIDDEN) and `storefront` kept on the error.
export const getStorefronts = async () => {
	try {
		const response = await api.get('/storefronts');
		return response.data.data;
	} catch (error) {
		throw toApiError(error, 'Lỗi khi tải danh sách gian hàng');
	}
};

export const getStorefrontCatalog = async (slug, params = {}) => {
	try {
		const response = await api.get(`/storefronts/${encodeURIComponent(slug)}/catalog`, { params });
		return response.data.data;
	} catch (error) {
		throw toApiError(error, 'Lỗi khi tải gian hàng');
	}
};

// Admin storefronts, access rules and email lists. Every method resolves `response.data`
// (`{ success, data, meta?, message? }`) and rejects with the server's message and `code`.
const adminCall = (fallback, request) => async (...args) => {
	try {
		const response = await request(...args);
		return response.data;
	} catch (error) {
		throw toApiError(error, fallback);
	}
};

export const storefrontAdminService = {
	list: adminCall('Lỗi khi tải danh sách gian hàng', () => api.get('/admin/storefronts')),
	create: adminCall('Lỗi khi tạo gian hàng', (payload) => api.post('/admin/storefronts', payload)),
	update: adminCall('Lỗi khi cập nhật gian hàng', (id, payload) => api.put(`/admin/storefronts/${id}`, payload)),
	remove: adminCall('Lỗi khi xóa gian hàng', (id) => api.delete(`/admin/storefronts/${id}`)),
	reorder: adminCall('Lỗi khi sắp xếp gian hàng', (ids) => api.put('/admin/storefronts/reorder', { ids })),
	listRules: adminCall('Lỗi khi tải quy tắc truy cập', (id) => api.get(`/admin/storefronts/${id}/rules`)),
	addRule: adminCall('Lỗi khi thêm quy tắc truy cập', (id, rule) => api.post(`/admin/storefronts/${id}/rules`, rule)),
	removeRule: adminCall('Lỗi khi xóa quy tắc truy cập', (id, ruleId) => api.delete(`/admin/storefronts/${id}/rules/${ruleId}`))
};

export const emailListService = {
	list: adminCall('Lỗi khi tải danh sách email', () => api.get('/admin/email-lists')),
	create: adminCall('Lỗi khi tạo danh sách email', (payload) => api.post('/admin/email-lists', payload)),
	update: adminCall('Lỗi khi cập nhật danh sách email', (id, payload) => api.put(`/admin/email-lists/${id}`, payload)),
	remove: adminCall('Lỗi khi xóa danh sách email', (id) => api.delete(`/admin/email-lists/${id}`)),
	listEntries: adminCall('Lỗi khi tải email trong danh sách', (id, params) => api.get(`/admin/email-lists/${id}/entries`, { params })),
	// Up to EMAIL_LIST_ENTRIES_MAX per call; resolves `{ data: { added, skipped } }`.
	addEntries: adminCall('Lỗi khi thêm email', (id, emails) => api.post(`/admin/email-lists/${id}/entries`, { emails }, { timeout: 30000 })),
	removeEntry: adminCall('Lỗi khi xóa email', (id, entryId) => api.delete(`/admin/email-lists/${id}/entries/${entryId}`)),
	clear: adminCall('Lỗi khi xóa toàn bộ email', (id) => api.delete(`/admin/email-lists/${id}/entries`))
};

export default api;
