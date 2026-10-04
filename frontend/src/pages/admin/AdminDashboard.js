import React, { useState, useEffect } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { adminService, formatCurrency, formatDate, getStatusText, getStatusColor } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';
import Modal from '../../components/Modal';
import ChangePassword from '../../components/ChangePassword';
import OrderNotesPanel from '../../components/admin/OrderNotesPanel';
import { isFinalOrderStatus } from '../../utils/order-status';

const AdminDashboard = () => {
	const [stats, setStats] = useState(null);
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

	// Handle ESC key to close modal
	useEffect(() => {
		const handleEscKey = (event) => {
			if (event.key === 'Escape' && selectedOrderStatus) {
				setSelectedOrderStatus(null);
			}
		};

		document.addEventListener('keydown', handleEscKey);
		return () => document.removeEventListener('keydown', handleEscKey);
	}, [selectedOrderStatus]);

	// Handle modal close
	const closeModal = () => {
		setSelectedOrderStatus(null);
	};

	// Fetch dashboard stats
	useEffect(() => {
		const fetchStats = async () => {
			try {
				const response = await adminService.getDashboardStats();
				if (response.success) {
					setStats(response.data);
				}
			} catch (error) {
				console.error('Error fetching stats:', error);
				toast.error('Lỗi khi tải thống kê');
			}
		};

		fetchStats();
	}, []);

	// Fetch orders
	useEffect(() => {
		const fetchOrders = async () => {
			try {
				setOrdersLoading(true);
				const response = await adminService.getOrders(filters);

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

	// Keep the open modal and the list row in sync with the saved order
	const handleNotesSaved = (updatedOrder) => {
		setSelectedOrderStatus(prev => (prev && prev._id === updatedOrder._id ? { ...prev, ...updatedOrder } : prev));
		setOrders(prev => prev.map(o => (o._id === updatedOrder._id ? { ...o, ...updatedOrder } : o)));
	};

	// Handle order status update
	const handleStatusUpdate = async (orderId, currentStatus) => {
		const allStatuses = ['confirmed', 'paid', 'delivered', 'cancelled'];

		const statusLabels = {
			'confirmed': 'Đã xác nhận',
			'paid': 'Đã thanh toán',
			'delivered': 'Đã giao hàng',
			'cancelled': 'Hủy đơn hàng'
		};

		const inputOptions = allStatuses.reduce((acc, status) => {
			acc[status] = statusLabels[status] + (status === currentStatus ? ' (Hiện tại)' : '');
			return acc;
		}, {});

		const { value: selectedStatus } = await Swal.fire({
			title: 'Cập nhật trạng thái',
			html: `
				<p class="mb-2">Chọn trạng thái cho đơn hàng:</p>
				<p class="text-sm text-gray-600 mb-4">Đơn đã huỷ hoặc đã giao hàng không đổi trạng thái được nữa</p>
			`,
			input: 'select',
			inputOptions: inputOptions,
			inputValue: currentStatus,
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

		// Ask for optional note to document the change
		const { value: note } = await Swal.fire({
			title: 'Ghi chú (Tùy chọn)',
			text: 'Thêm ghi chú về việc thay đổi trạng thái này (khuyến nghị cho việc sửa dữ liệu):',
			input: 'textarea',
			inputPlaceholder: 'Ví dụ: Sửa lại trạng thái do nhập sai...',
			showCancelButton: true,
			confirmButtonText: 'Tiếp tục',
			cancelButtonText: 'Bỏ qua',
			inputValidator: (value) => {
				if (value && value.trim().length > 500) {
					return 'Ghi chú không được vượt quá 500 ký tự!';
				}
			}
		});

		if (note && note.trim()) {
			updateData.note = note.trim();
		}

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
			const response = await adminService.updateOrderStatus(orderId, updateData);

			if (response.success) {
				toast.success('Cập nhật trạng thái đơn hàng thành công');

				// Refresh orders list
				const ordersResponse = await adminService.getOrders(filters);
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
				const ordersResponse = await adminService.getOrders(filters);
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

	// Handle export to Excel
	const handleExport = async () => {
		try {
			const exportFilters = {
				status: filters.status,
				search: filters.search
			};

			await adminService.exportOrders(exportFilters);
			toast.success('Xuất file Excel thành công');
		} catch (error) {
			console.error('Export error:', error);
			toast.error(error.message || 'Lỗi khi xuất file Excel');
		}
	};

	// Handle delete all orders
	const handleDeleteAllOrders = async () => {
		// First confirmation
		const firstConfirm = await Swal.fire({
			title: 'Xóa toàn bộ đơn hàng?',
			text: 'Bạn có chắc chắn muốn xóa TOÀN BỘ đơn hàng? Hành động này không thể hoàn tác!',
			icon: 'warning',
			showCancelButton: true,
			confirmButtonColor: '#ef4444',
			cancelButtonColor: '#6b7280',
			confirmButtonText: 'Tiếp tục',
			cancelButtonText: 'Hủy bỏ',
			focusCancel: true
		});

		if (!firstConfirm.isConfirmed) return;

		// Second confirmation with text input
		const { value: confirmText } = await Swal.fire({
			title: 'XÁC NHẬN CUỐI CÙNG',
			html: `
        <div class="text-left">
          <p class="mb-4 text-red-600 font-semibold">⚠️ CẢNH BÁO: Hành động này sẽ xóa vĩnh viễn toàn bộ đơn hàng!</p>
          <p class="mb-4">Để xác nhận, vui lòng nhập chính xác: <strong>XOA TAT CA</strong></p>
        </div>
      `,
			input: 'text',
			inputPlaceholder: 'Nhập "XOA TAT CA" để xác nhận',
			showCancelButton: true,
			confirmButtonColor: '#ef4444',
			cancelButtonColor: '#6b7280',
			confirmButtonText: 'Xóa toàn bộ đơn hàng',
			cancelButtonText: 'Hủy bỏ',
			focusCancel: true,
			inputValidator: (value) => {
				if (!value) {
					return 'Vui lòng nhập text xác nhận!';
				}
				if (value.trim().toUpperCase() !== 'XOA TAT CA') {
					return 'Text xác nhận không chính xác. Vui lòng nhập "XOA TAT CA"';
				}
			},
			preConfirm: (inputValue) => {
				if (inputValue.trim().toUpperCase() !== 'XOA TAT CA') {
					Swal.showValidationMessage('Text xác nhận không chính xác!');
					return false;
				}
				return true;
			}
		});

		if (!confirmText) return;

		// Final confirmation
		const finalConfirm = await Swal.fire({
			title: 'THỰC HIỆN XÓA?',
			text: 'Đây là cơ hội cuối cùng để hủy bỏ. Bạn có thực sự muốn xóa toàn bộ đơn hàng?',
			icon: 'error',
			showCancelButton: true,
			confirmButtonColor: '#dc2626',
			cancelButtonColor: '#059669',
			confirmButtonText: 'Có, xóa toàn bộ!',
			cancelButtonText: 'Không, giữ lại!',
			focusCancel: true
		});

		if (!finalConfirm.isConfirmed) return;

		// Show loading
		Swal.fire({
			title: 'Đang xóa đơn hàng...',
			text: 'Vui lòng chờ trong giây lát',
			allowOutsideClick: false,
			allowEscapeKey: false,
			showConfirmButton: false,
			didOpen: () => {
				Swal.showLoading();
			}
		});

		try {
			const response = await adminService.deleteAllOrders();

			if (response.success) {
				Swal.close();

				// Success notification
				await Swal.fire({
					title: 'Xóa thành công!',
					text: `Đã xóa ${response.data?.deletedCount || 0} đơn hàng`,
					icon: 'success',
					confirmButtonText: 'OK'
				});

				// Refresh data
				const [statsResponse, ordersResponse] = await Promise.all([
					adminService.getDashboardStats(),
					adminService.getOrders(filters)
				]);

				if (statsResponse.success) {
					setStats(statsResponse.data);
				}

				if (ordersResponse.success) {
					setOrders(ordersResponse.data.orders);
					setPagination(ordersResponse.data.pagination);
				}

				// Reset filters
				setFilters(prev => ({
					...prev,
					search: '',
					status: '',
					page: 1
				}));

				toast.success('Đã xóa toàn bộ đơn hàng thành công');
			}
		} catch (error) {
			console.error('Error deleting all orders:', error);

			Swal.close();

			await Swal.fire({
				title: 'Lỗi!',
				text: error.message || 'Có lỗi xảy ra khi xóa đơn hàng',
				icon: 'error',
				confirmButtonText: 'OK'
			});

			toast.error('Lỗi khi xóa đơn hàng');
		}
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
					<ChangePassword userType="admin" title="Đổi mật khẩu Admin" />
				</div>
			</div>

			{/* Statistics Cards */}
			{stats && (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
					{/* Total Orders */}
					<div className="card">
						<div className="p-6">
							<div className="flex items-center">
								<div className="flex-1">
									<p className="text-sm font-medium text-gray-600">Tổng đơn hàng</p>
									<p className="text-2xl font-bold text-gray-900">{stats.orders.total}</p>
								</div>
								<div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
									<i className="fas fa-shopping-cart text-blue-700 text-xl"></i>
								</div>
							</div>
						</div>
					</div>

					{/* Today Orders */}
					<div className="card">
						<div className="p-6">
							<div className="flex items-center">
								<div className="flex-1">
									<p className="text-sm font-medium text-gray-600">Hôm nay</p>
									<p className="text-2xl font-bold text-gray-900">{stats.orders.today}</p>
								</div>
								<div className="w-12 h-12 bg-success-100 rounded-lg flex items-center justify-center">
									<i className="fas fa-calendar-day text-success-600 text-xl"></i>
								</div>
							</div>
						</div>
					</div>

					{/* This Week */}
					<div className="card">
						<div className="p-6">
							<div className="flex items-center">
								<div className="flex-1">
									<p className="text-sm font-medium text-gray-600">Tuần này</p>
									<p className="text-2xl font-bold text-gray-900">{stats.orders.week}</p>
								</div>
								<div className="w-12 h-12 bg-warning-100 rounded-lg flex items-center justify-center">
									<i className="fas fa-calendar-week text-warning-600 text-xl"></i>
								</div>
							</div>
						</div>
					</div>

					{/* Revenue */}
					<div className="card">
						<div className="p-6">
							<div className="flex items-center">
								<div className="flex-1">
									<p className="text-sm font-medium text-gray-600">Doanh thu</p>
									<p className="text-2xl font-bold text-gray-900">
										{formatCurrency(stats.revenue)}
									</p>
								</div>
								<div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
									<i className="fas fa-dollar-sign text-green-600 text-xl"></i>
								</div>
							</div>
						</div>
					</div>
				</div>
			)}

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

							{/* Export Button */}
							<button
								onClick={handleExport}
								className="btn-success whitespace-nowrap"
							>
								<i className="fas fa-file-excel mr-2"></i>
								Xuất Excel
							</button>

							{/* Delete All Orders Button */}
							<button
								onClick={handleDeleteAllOrders}
								className="btn-danger whitespace-nowrap"
								disabled={orders.length === 0}
								title={orders.length === 0 ? 'Không có đơn hàng để xóa' : 'Xóa toàn bộ đơn hàng'}
							>
								<i className="fas fa-trash-alt mr-2"></i>
								Xóa tất cả
							</button>
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
										Mã giao dịch
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
													// display last 4 characters only for easier packing
													const displayedName = item.productName.slice(itemNameLength - 4, itemNameLength);
													return (
														<div key={index} className="flex justify-between items-center mb-1 last:mb-0">
															<div className="flex items-center">
																<span className="text-gray-700">{displayedName}</span>
																{item.fromCombo && (
																	<span className="ml-1 text-xs bg-blue-100 text-blue-600 px-1 rounded" title={`Từ combo: ${item.comboName}`}>
																		C
																	</span>
																)}
															</div>
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
											{order.transactionCode ? (
												<span className="font-mono text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
													{order.transactionCode}
												</span>
											) : (
												<span className="text-gray-400">-</span>
											)}
										</td>
										<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
											{formatDate(order.createdAt)}
										</td>
										<td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
											{isFinalOrderStatus(order.status) ? (
												<span className="text-xs text-gray-500">
													Trạng thái cuối — chỉ sửa ghi chú
												</span>
											) : (
												<button
													onClick={() => handleStatusUpdate(order._id, order.status)}
													className="text-blue-700 hover:text-blue-900 mr-3"
													title="Cập nhật trạng thái đơn hàng"
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

						<OrderNotesPanel order={selectedOrderStatus} onSaved={handleNotesSaved} />

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

export default AdminDashboard;
