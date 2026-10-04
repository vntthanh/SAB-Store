import api from './api';

// The ledger endpoints return the server's Vietnamese message on failure; surface it
// so callers can toast it as-is instead of a generic string.
const unwrap = async (request, fallback) => {
	try {
		const response = await request();
		return response.data;
	} catch (error) {
		throw new Error(error.response?.data?.message || fallback);
	}
};

export const adjustStock = (productId, { mode, value, reason }) =>
	unwrap(
		() => api.post(`/admin/products/${productId}/stock-adjustments`, { mode, value, reason }),
		'Lỗi khi ghi điều chỉnh tồn kho'
	);

export const getStockMovements = (productId, { page = 1, limit = 10 } = {}) =>
	unwrap(
		() => api.get(`/admin/products/${productId}/stock-movements`, { params: { page, limit } }),
		'Lỗi khi tải lịch sử tồn kho'
	);

export const getStockReconcile = () =>
	unwrap(() => api.get('/admin/stock/reconcile'), 'Lỗi khi tải đối soát tồn kho');
