import React, { useState, useEffect } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { sellerService, formatCurrency, formatDate, getStatusText, getStatusColor } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import ChangePassword from '../../components/ChangePassword';
import { isFinalOrderStatus } from '../../utils/order-status';

const SellerDashboard = () => {
	// const [stats, setStats] = useState(null); // Xóa thống kê cho seller
	const [orders, setOrders] = useState([]);
	const [loading, setLoading] = useState(true);
	const [ordersLoading, setOrdersLoading] = useState(false);
	const [error, setError] = useState('');
	const [selectedOrderStatus, setSelectedOrderStatus] = useState(null);

	// Filters and pagination
	const [filters, setFilters] = useState({
		search: '',
		status: '',
		page: 1,
		limit: 10
	});
	const [pagination, setPagination] = useState(null);

	// Handle modal close
	const closeModal = () => {
		setSelectedOrderStatus(null);
	};

	// Đã xóa phần thống kê dashboard cho seller

	// Fetch orders
	useEffect(() => {
		const fetchOrders = async () => {
			try {
				setOrdersLoading(true);
				const response = await sellerService.getOrders(filters);

				if (response.success) {
					setOrders(response.data.orders);
					setPagination(response.data.pagination);
				}
			} catch (error) {
				console.error('Error fetching orders:', error);
				setError(error.message);
				toast.error('Lỗi khi tải danh sách đơn hàng');
			} finally {
				setOrdersLoading(false);
				setLoading(false);
			}
		};

		fetchOrders();
	}, [filters]);

	// Handle filter changes
	const handleFilterChange = (key, value) => {
		setFilters(prev => ({
			...prev,
			[key]: value,
			page: 1 // Reset to first page when filtering
		}));
	};

	// Handle pagination
	const handlePageChange = (newPage) => {
		setFilters(prev => ({
			...prev,
			page: newPage
		}));
	};

	// Handle order status update
	const handleStatusUpdate = async (orderId, currentStatus) => {
		const statusOptions = {
			'confirmed': ['paid', 'cancelled'],
			'paid': ['delivered', 'cancelled']
		};
		const availableStatuses = isFinalOrderStatus(currentStatus) ? [] : (statusOptions[currentStatus] || []);

		if (availableStatuses.length === 0) {
			toast.warning('Không có trạng thái nào khác để thay đổi');
			return;
		}

		const statusLabels = {
			'paid': 'Đã thanh toán',
			'delivered': 'Đã giao hàng',
			'cancelled': 'Hủy đơn hàng'
		};

		const options = availableStatuses.map(status => ({
			value: status,
			label: statusLabels[status]
		}));

		const { value: selectedStatus } = await Swal.fire({
			title: 'Cập nhật trạng thái',
			text: 'Chọn trạng thái mới cho đơn hàng:',
			input: 'select',
			inputOptions: options.reduce((acc, option) => {
				acc[option.value] = option.label;
				return acc;
			}, {}),
			showCancelButton: true,
			confirmButtonText: 'Cập nhật',
			cancelButtonText: 'Hủy',
			inputValidator: (value) => {
				if (!value) {
					return 'Vui lòng chọn trạng thái!';
				}
			}
		});

		if (!selectedStatus) return;

		let updateData = { status: selectedStatus };

		// Handle specific status requirements
		if (selectedStatus === 'paid') {
			const { value: transactionCode } = await Swal.fire({
				title: 'Mã giao dịch',
				text: 'Nhập mã giao dịch thanh toán:',
				input: 'text',
				inputPlaceholder: 'Ví dụ: TXN123456789',
				showCancelButton: true,
				confirmButtonText: 'Xác nhận',
				cancelButtonText: 'Hủy',
				inputValidator: (value) => {
					if (!value || value.trim().length === 0) {
						return 'Mã giao dịch là bắt buộc!';
					}
					if (value.trim().length > 50) {
						return 'Mã giao dịch không được vượt quá 50 ký tự!';
					}
				}
			});

			if (!transactionCode) return;
			updateData.transactionCode = transactionCode.trim();
		}

		if (selectedStatus === 'delivered') {
			const result = await Swal.fire({
				title: 'Xác nhận giao hàng',
				text: 'Bạn có chắc chắn đơn hàng này đã được giao thành công?',
				icon: 'warning',
				showCancelButton: true,
				confirmButtonColor: '#22c55e',
				cancelButtonColor: '#6b7280',
				confirmButtonText: 'Xác nhận',
				cancelButtonText: 'Hủy'
			});

			if (!result.isConfirmed) return;
		}

		if (selectedStatus === 'cancelled') {
			const { value: cancelReason } = await Swal.fire({
				title: 'Lý do hủy đơn hàng',
				text: 'Nhập lý do hủy đơn hàng:',
				input: 'textarea',
				inputPlaceholder: 'Ví dụ: Hết hàng, khách hàng yêu cầu hủy...',
				showCancelButton: true,
				confirmButtonText: 'Hủy đơn hàng',
				cancelButtonText: 'Quay lại',
				confirmButtonColor: '#ef4444',
				inputValidator: (value) => {
					if (!value || value.trim().length === 0) {
						return 'Lý do hủy là bắt buộc!';
					}
					if (value.trim().length > 500) {
						return 'Lý do hủy không được vượt quá 500 ký tự!';
					}
				}
			});

			if (!cancelReason) return;
			updateData.cancelReason = cancelReason.trim();
		}

		try {
			const response = await sellerService.updateOrderStatus(orderId, updateData);

			if (response.success) {
				toast.success('Cập nhật trạng thái đơn hàng thành công');

				// Refresh orders list
				const ordersResponse = await sellerService.getOrders(filters);
				if (ordersResponse.success) {
					setOrders(ordersResponse.data.orders);
					setPagination(ordersResponse.data.pagination);
				}
			}
		} catch (error) {
			console.error('Error updating order:', error);
			toast.error(error.message || 'Lỗi khi cập nhật trạng thái đơn hàng');
			// The row may be stale (e.g. another tab already delivered the order):
			// reload so its status and buttons match the server.
			try {
				const ordersResponse = await sellerService.getOrders(filters);
				if (ordersResponse.success) {
					setOrders(ordersResponse.data.orders);
					setPagination(ordersResponse.data.pagination);
				}
			} catch (refreshError) {
				console.error('Error refreshing orders:', refreshError);
			}
		}
	};

	// Show status details
	const showStatusDetails = (order) => {
		setSelectedOrderStatus(order);
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-64">
				<LoadingSpinner size="large" text="Đang tải dashboard..." />
			</div>
		);
	}

	if (error) {
		return (
			<div className="text-center py-12">
				<i className="fas fa-exclamation-triangle text-6xl text-danger-500 mb-4"></i>
				<h2 className="text-2xl font-bold text-gray-900 mb-2">Có lỗi xảy ra</h2>
				<p className="text-gray-600 mb-4">{error}</p>
				<button
					onClick={() => window.location.reload()}
					className="btn-primary"
				>
					Thử lại
				</button>
			</div>
		);
	}

	return (
		<div className="space-y-8">
			{/* Dashboard Header */}
			<div className="flex justify-between items-center">
				<div>
					<h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
					<p className="text-gray-600">Quản lý đơn hàng và thống kê</p>
				</div>
				<div>
					<ChangePassword userType="seller" title="Đổi mật khẩu" />
				</div>
			</div>

			{/* Orders Management */}
			<div className="card">
				<div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
					<div className="flex flex-col lg:flex-row lg:items-center justify-between space-y-4 lg:space-y-0">
						<h2 className="text-xl font-semibold text-gray-900">
							Quản lý đơn hàng
						</h2>

						{/* Filters and Actions */}
						<div className="flex flex-col sm:flex-row gap-3">
							{/* Search */}
							<div className="relative">
								<i className="fas fa-search absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"></i>
								<input
									type="text"
									placeholder="Tìm theo mã đơn, MSSV, tên..."
									value={filters.search}
									onChange={(e) => handleFilterChange('search', e.target.value)}
									className="form-input pl-10 w-full sm:w-64"
								/>
							</div>

							{/* Status Filter */}
							<select
								value={filters.status}
								onChange={(e) => handleFilterChange('status', e.target.value)}
								className="form-input w-full sm:w-40"
							>
								<option value="">Tất cả trạng thái</option>
								<option value="confirmed">Đã xác nhận</option>
								<option value="paid">Đã thanh toán</option>
								<option value="delivered">Đã giao hàng</option>
								<option value="cancelled">Đã hủy</option>
							</select>

						</div>
					</div>
				</div>

				{/* Orders Table */}
				<div className="overflow-x-auto">
					{ordersLoading ? (
						<div className="p-12 text-center">
							<LoadingSpinner size="large" text="Đang tải đơn hàng..." />
						</div>
					) : orders.length === 0 ? (
						<div className="p-12 text-center">
							<i className="fas fa-inbox text-6xl text-gray-300 mb-4"></i>
							<h3 className="text-xl font-semibold text-gray-900 mb-2">
								Không có đơn hàng
							</h3>
							<p className="text-gray-600">
								{filters.search || filters.status
									? 'Không tìm thấy đơn hàng phù hợp với bộ lọc'
									: 'Chưa có đơn hàng nào được tạo'
								}
							</p>
						</div>
					) : (
						<table className="min-w-full divide-y divide-gray-200">
							<thead className="bg-gray-50">
								<tr>
									<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
										Đơn hàng
									</th>
									<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
										Khách hàng
									</th>
									<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
										Sản phẩm
									</th>
									<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
										Tổng tiền
									</th>
									<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
										Trạng thái
									</th>
									<th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
										Ngày tạo
									</th>
									<th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
										Hành động
									</th>
								</tr>
							</thead>
							<tbody className="bg-white divide-y divide-gray-200">
								{orders.map((order) => (
									<tr key={order._id} className="hover:bg-gray-50">
										<td className="px-6 py-4 whitespace-nowrap">
											<div>
												<div className="text-sm font-medium text-gray-900">
													#{order.orderCode}
												</div>
												<div className="text-sm text-gray-500">
													{order.items.length} sản phẩm
												</div>
											</div>
										</td>
										<td className="px-6 py-4">
											<div className="text-sm text-gray-900">{order.fullName}</div>
											<div className="text-sm text-gray-500">{order.studentId}</div>
											<div className="text-sm text-gray-500">{order.email}</div>
											<div className="text-sm text-gray-500">{order.phoneNumber}</div>
											<div className="text-sm text-gray-500">{order.additionalNote}</div>
										</td>
										<td className="px-6 py-4">
											<div className="text-sm text-gray-900">
												{order.items.map((item, index) => {
													const itemNameLength = item.productName.length;
													// display last 4 characters only
													const displayedName = item.productName.slice(itemNameLength - 4, itemNameLength);
													return (
														<div key={index} className="flex justify-between items-center mb-1 last:mb-0">
															<span className="text-gray-700">{displayedName}</span>
															<span className="text-gray-500 ml-2">x{item.quantity}</span>
														</div>
													);
												})}
											</div>
										</td>
										<td className="px-6 py-4 whitespace-nowrap">
											<div className="text-sm font-semibold text-gray-900">
												{formatCurrency(order.totalAmount)}
											</div>
										</td>
										<td className="px-6 py-4 whitespace-nowrap">
											<button
												onClick={() => showStatusDetails(order)}
												className={`badge ${getStatusColor(order.status)} hover:opacity-80 transition-opacity cursor-pointer`}
												title="Click để xem chi tiết trạng thái"
											>
												{getStatusText(order.status)}
												<i className="fas fa-info-circle ml-1 text-xs"></i>
											</button>
										</td>
										<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
											{formatDate(order.createdAt)}
										</td>
										<td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
											{!isFinalOrderStatus(order.status) && (
												<button
													onClick={() => handleStatusUpdate(order._id, order.status)}
													className="text-primary-600 hover:text-primary-900 mr-3"
												>
													<i className="fas fa-edit mr-1"></i>
													Cập nhật
												</button>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>

				{/* Pagination */}
				{pagination && pagination.totalPages > 1 && (
					<div className="bg-gray-50 px-6 py-3 border-t border-gray-200">
						<div className="flex items-center justify-between">
							<div className="text-sm text-gray-700">
								Hiển thị {((pagination.currentPage - 1) * pagination.itemsPerPage) + 1} đến{' '}
								{Math.min(pagination.currentPage * pagination.itemsPerPage, pagination.totalItems)} trong{' '}
								{pagination.totalItems} đơn hàng
							</div>

							<div className="flex space-x-2">
								<button
									onClick={() => handlePageChange(pagination.currentPage - 1)}
									disabled={!pagination.hasPrev}
									className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
								>
									<i className="fas fa-chevron-left"></i>
								</button>

								<span className="px-3 py-2 text-sm text-gray-700">
									Trang {pagination.currentPage} / {pagination.totalPages}
								</span>

								<button
									onClick={() => handlePageChange(pagination.currentPage + 1)}
									disabled={!pagination.hasNext}
									className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
								>
									<i className="fas fa-chevron-right"></i>
								</button>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Status Details Modal */}
			<Modal
				isOpen={!!selectedOrderStatus}
				onClose={closeModal}
				title="Chi tiết trạng thái đơn hàng"
			>
				{selectedOrderStatus && (
					<div className="space-y-4">
						{/* Order Code */}
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-1">
								Mã đơn hàng
							</label>
							<p className="text-sm text-gray-900">#{selectedOrderStatus.orderCode}</p>
						</div>

						{/* Current Status */}
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-1">
								Trạng thái hiện tại
							</label>
							<span className={`badge ${getStatusColor(selectedOrderStatus.status)}`}>
								{getStatusText(selectedOrderStatus.status)}
							</span>
						</div>

						{/* Status Updated Time */}
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-1">
								Cập nhật lần cuối
							</label>
							<p className="text-sm text-gray-900">
								{formatDate(selectedOrderStatus.statusUpdatedAt || selectedOrderStatus.updatedAt)}
							</p>
						</div>

						{/* Transaction Code for paid status */}
						{selectedOrderStatus.status === 'paid' && selectedOrderStatus.transactionCode && (
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-1">
									Mã giao dịch
								</label>
								<p className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded border">
									{selectedOrderStatus.transactionCode}
								</p>
							</div>
						)}

						{/* Cancel Reason for cancelled status */}
						{selectedOrderStatus.status === 'cancelled' && selectedOrderStatus.cancelReason && (
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-1">
									Lý do hủy đơn hàng
								</label>
								<p className="text-sm text-gray-900 bg-red-50 px-3 py-2 rounded border border-red-200">
									{selectedOrderStatus.cancelReason}
								</p>
							</div>
						)}

						{/* Order Timeline */}
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-2">
								Lịch sử trạng thái
							</label>
							<div className="space-y-2">
								{/* Initial creation */}
								<div className="flex items-center text-sm">
									<div className="w-2 h-2 bg-blue-400 rounded-full mr-3"></div>
									<div className="flex-1">
										<span className="text-gray-900">Đơn hàng được tạo</span>
										<span className="text-gray-500 ml-2">
											{formatDate(selectedOrderStatus.createdAt)}
										</span>
										<span className="text-gray-400 ml-2">• system</span>
									</div>
								</div>

								{/* Status history */}
								{selectedOrderStatus.statusHistory && selectedOrderStatus.statusHistory.length > 0 ? (
									selectedOrderStatus.statusHistory.map((history, index) => (
										<div key={index} className="flex items-start text-sm">
											<div className={`w-2 h-2 rounded-full mr-3 mt-1 ${history.status === 'paid' ? 'bg-green-400' :
												history.status === 'delivered' ? 'bg-green-600' :
													history.status === 'cancelled' ? 'bg-red-400' : 'bg-gray-400'
												}`}></div>
											<div className="flex-1">
												<div>
													<span className="text-gray-900">{getStatusText(history.status)}</span>
													<span className="text-gray-500 ml-2">
														{formatDate(history.updatedAt)}
													</span>
													<span className="text-gray-400 ml-2">• {history.updatedBy}</span>
												</div>
												{history.transactionCode && (
													<div className="text-xs text-gray-600 mt-1">
														Mã GD: {history.transactionCode}
													</div>
												)}
												{history.cancelReason && (
													<div className="text-xs text-gray-600 mt-1">
														Lý do: {history.cancelReason}
													</div>
												)}
												{history.note && (
													<div className="text-xs text-gray-600 mt-1">
														Ghi chú: {history.note}
													</div>
												)}
											</div>
										</div>
									))
								) : selectedOrderStatus.status !== 'confirmed' && (
									<div className="flex items-center text-sm">
										<div className={`w-2 h-2 rounded-full mr-3 ${selectedOrderStatus.status === 'paid' ? 'bg-green-400' :
											selectedOrderStatus.status === 'delivered' ? 'bg-green-600' :
												selectedOrderStatus.status === 'cancelled' ? 'bg-red-400' : 'bg-gray-400'
											}`}></div>
										<div className="flex-1">
											<span className="text-gray-900">
												{getStatusText(selectedOrderStatus.status)}
											</span>
											<span className="text-gray-500 ml-2">
												{formatDate(selectedOrderStatus.statusUpdatedAt || selectedOrderStatus.updatedAt)}
											</span>
											<span className="text-gray-400 ml-2">• {selectedOrderStatus.lastUpdatedBy || 'system'}</span>
										</div>
									</div>
								)}
							</div>
						</div>

						{/* Customer Info */}
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-1">
								Thông tin khách hàng
							</label>
							<div className="bg-gray-50 px-3 py-2 rounded border space-y-1">
								<p className="text-sm"><strong>Tên:</strong> {selectedOrderStatus.fullName}</p>
								<p className="text-sm"><strong>MSSV:</strong> {selectedOrderStatus.studentId}</p>
								<p className="text-sm"><strong>Email:</strong> {selectedOrderStatus.email}</p>
							</div>
						</div>

						{/* Total Amount */}
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-1">
								Tổng tiền
							</label>
							<p className="text-lg font-semibold text-gray-900">
								{formatCurrency(selectedOrderStatus.totalAmount)}
							</p>
						</div>
					</div>
				)}
			</Modal>
		</div>
	);
};

export default SellerDashboard;
