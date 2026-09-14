import axios from 'axios';
import { authClient } from '../lib/auth-client';

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
		if (error.response?.status === 401) {
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

// Product Services
export const productService = {
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
			throw new Error(error.response?.data?.message || 'Lỗi khi tạo đơn hàng');
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
			return session && session.user && session.user.role === 'admin';
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

	// Change password
	changePassword: async (currentPassword, newPassword) => {
		try {
			const response = await api.post('/admin/change-password', {
				currentPassword,
				newPassword
			});
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi đổi mật khẩu');
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

	// Product management
	getProducts: async () => {
		try {
			const response = await api.get('/admin/products');
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

	// Create direct sale order (admin)
	createDirectOrder: async (orderData) => {
		try {
			const response = await api.post('/admin/orders/direct', orderData);
			return response.data;
		} catch (error) {
			console.error('API Error - createDirectOrder:', error.response?.data || error.message);
			throw error;
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
	getCombos: async () => {
		try {
			const response = await api.get('/combos');
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
			return session && session.user && (session.user.role === 'seller' || session.user.role === 'admin');
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
			throw new Error(error.response?.data?.message || 'Lỗi khi đổi mật khẩu');
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
			throw new Error(error.response?.data?.message || 'Lỗi khi tạo đơn hàng trực tiếp');
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
	// Detect applicable combos for given items
	detectCombos: async (items) => {
		try {
			const response = await api.post('/combos/detect', { items });
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi phát hiện combo');
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

	// Calculate optimal pricing for items
	calculatePricing: async (items) => {
		try {
			const response = await api.post('/combos/pricing', { items });
			return response.data;
		} catch (error) {
			throw new Error(error.response?.data?.message || 'Lỗi khi tính toán giá tối ưu');
		}
	}
};

export default api;
