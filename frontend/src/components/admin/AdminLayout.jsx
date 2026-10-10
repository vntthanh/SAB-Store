import React from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import { authClient } from '../../lib/auth-client';
import Swal from 'sweetalert2';
import Logo from '../Logo';

const AdminLayout = ({ children }) => {
	const navigate = useNavigate();
	const location = useLocation();

	const handleLogout = async () => {
		const result = await Swal.fire({
			title: 'Đăng xuất',
			text: 'Bạn có chắc chắn muốn đăng xuất?',
			icon: 'question',
			showCancelButton: true,
			confirmButtonColor: '#ef4444',
			cancelButtonColor: '#6b7280',
			confirmButtonText: 'Đăng xuất',
			cancelButtonText: 'Hủy'
		});

		if (result.isConfirmed) {
			try {
				await authClient.signOut();
				toast.success('Đã đăng xuất thành công');
				navigate('/login');
			} catch (error) {
				console.error('Logout error:', error);
				toast.error('Lỗi khi đăng xuất');
			}
		}
	};

	const isActiveRoute = (path) => {
		return location.pathname === path;
	};

	return (
		<div className="min-h-screen bg-gray-50">
			{/* Admin Header */}
			<header className="bg-white shadow-sm border-b border-gray-200">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="flex justify-between items-center h-16">
						{/* Logo */}
						<div className="flex items-center space-x-4">
							<Link
								to="/admin/dashboard"
								className="flex items-center space-x-3 text-xl font-bold text-blue-800 hover:text-blue-900"
							>
								<Logo size="md" />
								<span className="text-blue-800 hidden sm:inline">
									<span className="text-yellow-500">|</span> Admin Panel
								</span>
							</Link>
						</div>

						{/* Navigation */}
						<nav className="hidden md:flex space-x-6">
							<Link
								to="/admin/dashboard"
								className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActiveRoute('/admin/dashboard')
									? 'bg-primary-100 text-primary-700'
									: 'text-gray-700 hover:text-primary-600'
									}`}
							>
								<i className="fas fa-chart-line mr-2"></i>
								Dashboard
							</Link>
							<Link
								to="/admin/products"
								className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActiveRoute('/admin/products')
									? 'bg-primary-100 text-primary-700'
									: 'text-gray-700 hover:text-primary-600'
									}`}
							>
								<i className="fas fa-box mr-2"></i>
								Sản phẩm
							</Link>
							<Link
								to="/admin/combos"
								className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActiveRoute('/admin/combos')
									? 'bg-primary-100 text-primary-700'
									: 'text-gray-700 hover:text-primary-600'
									}`}
							>
								<i className="fas fa-boxes mr-2"></i>
								Combo
							</Link>
							<Link
								to="/admin/sellers"
								className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActiveRoute('/admin/sellers')
									? 'bg-primary-100 text-primary-700'
									: 'text-gray-700 hover:text-primary-600'
									}`}
							>
								<i className="fas fa-users mr-2"></i>
								Sellers
							</Link>
							<Link
								to="/admin/database"
								className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActiveRoute('/admin/database')
									? 'bg-primary-100 text-primary-700'
									: 'text-gray-700 hover:text-primary-600'
									}`}
							>
								<i className="fas fa-database mr-2"></i>
								Database
							</Link>
							<Link
								to="/admin/settings"
								className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActiveRoute('/admin/settings')
									? 'bg-primary-100 text-primary-700'
									: 'text-gray-700 hover:text-primary-600'
									}`}
							>
								<i className="fas fa-cog mr-2"></i>
								Cấu hình
							</Link>
							<Link
								to="/admin/direct-sales"
								className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActiveRoute('/admin/direct-sales')
									? 'bg-primary-100 text-primary-700'
									: 'text-gray-700 hover:text-primary-600'
									}`}
							>
								<i className="fas fa-cash-register mr-2"></i>
								Bán hàng trực tiếp
							</Link>
						</nav>

						{/* Admin Actions */}
						<div className="flex items-center space-x-4">
							{/* View Site */}
							<Link
								to="/"
								target="_blank"
								rel="noopener noreferrer"
								className="text-gray-600 hover:text-gray-900 transition-colors"
								title="Xem trang chủ"
							>
								<i className="fas fa-external-link-alt"></i>
							</Link>

							{/* Logout */}
							<button
								onClick={handleLogout}
								className="flex items-center space-x-2 text-gray-600 hover:text-gray-900 transition-colors"
								title="Đăng xuất"
							>
								<i className="fas fa-sign-out-alt"></i>
								<span className="hidden lg:inline">Đăng xuất</span>
							</button>
						</div>
					</div>
				</div>

				{/* Mobile Navigation */}
				<div className="md:hidden border-t">
					<div className="px-2 pt-2 pb-3 space-y-1">
						<Link
							to="/admin/dashboard"
							className={`block px-3 py-2 rounded-md text-base font-medium transition-colors ${isActiveRoute('/admin/dashboard')
								? 'bg-primary-100 text-primary-700'
								: 'text-gray-700 hover:text-primary-600'
								}`}
						>
							<i className="fas fa-chart-line mr-2"></i>
							Dashboard
						</Link>
						<Link
							to="/admin/products"
							className={`block px-3 py-2 rounded-md text-base font-medium transition-colors ${isActiveRoute('/admin/products')
								? 'bg-primary-100 text-primary-700'
								: 'text-gray-700 hover:text-primary-600'
								}`}
						>
							<i className="fas fa-box mr-2"></i>
							Sản phẩm
						</Link>
						<Link
							to="/admin/sellers"
							className={`block px-3 py-2 rounded-md text-base font-medium transition-colors ${isActiveRoute('/admin/sellers')
								? 'bg-primary-100 text-primary-700'
								: 'text-gray-700 hover:text-primary-600'
								}`}
						>
							<i className="fas fa-users mr-2"></i>
							Sellers
						</Link>
						<Link
							to="/admin/database"
							className={`block px-3 py-2 rounded-md text-base font-medium transition-colors ${isActiveRoute('/admin/database')
								? 'bg-primary-100 text-primary-700'
								: 'text-gray-700 hover:text-primary-600'
								}`}
						>
							<i className="fas fa-database mr-2"></i>
							Database
						</Link>
						<Link
							to="/admin/settings"
							className={`block px-3 py-2 rounded-md text-base font-medium transition-colors ${isActiveRoute('/admin/settings')
								? 'bg-primary-100 text-primary-700'
								: 'text-gray-700 hover:text-primary-600'
								}`}
						>
							<i className="fas fa-cog mr-2"></i>
							Cấu hình
						</Link>
						<Link
							to="/admin/direct-sales"
							className={`block px-3 py-2 rounded-md text-base font-medium transition-colors ${isActiveRoute('/admin/direct-sales')
								? 'bg-primary-100 text-primary-700'
								: 'text-gray-700 hover:text-primary-600'
								}`}
						>
							<i className="fas fa-cash-register mr-2"></i>
							Bán hàng trực tiếp
						</Link>
					</div>
				</div>
			</header>

			{/* Main Content */}
			<main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
				{children}
			</main>
		</div>
	);
};

export default AdminLayout;
