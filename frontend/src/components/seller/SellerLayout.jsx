import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import { authClient } from '../../lib/auth-client';
import Logo from '../Logo';

const SellerLayout = ({ children }) => {
	const navigate = useNavigate();
	const location = useLocation();
	const [username, setUsername] = useState('Seller');

	// Get username from authenticated session
	useEffect(() => {
		const getSessionUser = async () => {
			try {
				const { data: session } = await authClient.getSession();
				if (session?.user?.name) {
					setUsername(session.user.name);
				} else if (session?.user?.email) {
					// Fallback to email username
					setUsername(session.user.email.split('@')[0]);
				}
			} catch (error) {
				console.error('Error getting session:', error);
			}
		};
		getSessionUser();
	}, []);

	const handleLogout = async () => {
		try {
			await authClient.signOut();
			toast.success('Đăng xuất thành công');
			navigate('/login');
		} catch (error) {
			console.error('Logout error:', error);
			toast.error('Lỗi khi đăng xuất');
		}
	};

	const isActiveRoute = (path) => {
		return location.pathname === path;
	};

	return (
		<div className="min-h-screen bg-gray-50">
			{/* Header */}
			<header className="bg-white shadow-sm border-b">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="flex justify-between items-center h-16">
						{/* Logo */}
						<div className="flex items-center">
							<Link to="/seller/dashboard" className="flex items-center space-x-3">
								<Logo size="md" />
								<span className="text-xl font-bold text-blue-800 hidden sm:inline">
									<span className="text-yellow-500">|</span> Seller Panel
								</span>
							</Link>
						</div>

						{/* Navigation */}
						<nav className="hidden md:flex space-x-6">
							<Link
								to="/seller/dashboard"
								className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActiveRoute('/seller/dashboard')
									? 'bg-blue-100 text-blue-800'
									: 'text-gray-700 hover:text-blue-700'
									}`}
							>
								<i className="fas fa-chart-line mr-2"></i>
								Dashboard
							</Link>
							<Link
								to="/seller/direct-sales"
								className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${isActiveRoute('/seller/direct-sales')
									? 'bg-blue-100 text-blue-800'
									: 'text-gray-700 hover:text-blue-700'
									}`}
							>
								<i className="fas fa-cash-register mr-2"></i>
								Bán hàng trực tiếp
							</Link>
						</nav>

						{/* User Menu */}
						<div className="flex items-center space-x-4">
							<div className="hidden md:block text-sm text-gray-700">
								<i className="fas fa-user-circle mr-1"></i>
								{username}
							</div>
							<button
								onClick={handleLogout}
								className="bg-danger-600 hover:bg-danger-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
							>
								<i className="fas fa-sign-out-alt mr-2"></i>
								Đăng xuất
							</button>
						</div>
					</div>
				</div>

				{/* Mobile Navigation */}
				<div className="md:hidden border-t">
					<div className="px-2 pt-2 pb-3 space-y-1">
						<Link
							to="/seller/dashboard"
							className={`block px-3 py-2 rounded-md text-base font-medium transition-colors ${isActiveRoute('/seller/dashboard')
								? 'bg-primary-100 text-primary-700'
								: 'text-gray-700 hover:text-primary-600'
								}`}
						>
							<i className="fas fa-chart-line mr-2"></i>
							Dashboard
						</Link>
						<Link
							to="/seller/direct-sales"
							className={`block px-3 py-2 rounded-md text-base font-medium transition-colors ${isActiveRoute('/seller/direct-sales')
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
			<main className="max-w-7xl mx-auto">
				{children}
			</main>
		</div>
	);
};

export default SellerLayout;
