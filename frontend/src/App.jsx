import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

// Context
import { CartProvider } from './context/CartContext';

// Pages
import HomePage from './pages/HomePage';
import CheckoutPage from './pages/CheckoutPage';
import OrderSuccessPage from './pages/OrderSuccessPage';
import OrderTrackingPage from './pages/OrderTrackingPage';
import LoginPage from './pages/LoginPage';
import ProductDetailPage from './pages/ProductDetailPage';
import ComboDetailPage from './pages/ComboDetailPage';
import NotFoundPage from './pages/NotFoundPage';

// Admin Pages
import AdminDashboard from './pages/admin/AdminDashboard';
import ProductsManagement from './pages/admin/ProductsManagement';
import ComboManagement from './pages/admin/ComboManagement';
import SellersManagement from './pages/admin/SellersManagement';
import DatabaseManagement from './pages/admin/DatabaseManagement';
import SettingsManagement from './pages/admin/SettingsManagement';

// Seller Pages
import SellerDashboard from './pages/seller/SellerDashboard';
import DirectSalesPage from './pages/seller/DirectSalesPage';

// Components
import Layout from './components/Layout';
import AdminLayout from './components/admin/AdminLayout';
import SellerLayout from './components/seller/SellerLayout';
import ProtectedRoute from './components/admin/ProtectedRoute';
import SellerProtectedRoute from './components/seller/SellerProtectedRoute';

function App() {
	return (
		<Router>
			<CartProvider>
				<div className="App">
					<Routes>
						{/* Public Routes */}
						<Route path="/" element={<Layout />}>
							<Route index element={<HomePage />} />
							<Route path="checkout" element={<CheckoutPage />} />
							<Route path="order-success" element={<OrderSuccessPage />} />
							<Route path="order-tracking" element={<OrderTrackingPage />} />
							<Route path="p/:code/:slug?" element={<ProductDetailPage />} />
							<Route path="c/:code/:slug?" element={<ComboDetailPage />} />
							<Route path="*" element={<NotFoundPage />} />
						</Route>

						{/* Login Routes */}
						<Route path="/login" element={<LoginPage />} />

						{/* Admin Routes */}
						<Route path="/admin" element={<Navigate to="/login" replace />} />
						<Route path="/admin/dashboard" element={
							<ProtectedRoute>
								<AdminLayout>
									<AdminDashboard />
								</AdminLayout>
							</ProtectedRoute>
						} />
						<Route path="/admin/products" element={
							<ProtectedRoute>
								<AdminLayout>
									<ProductsManagement />
								</AdminLayout>
							</ProtectedRoute>
						} />
						<Route path="/admin/combos" element={
							<ProtectedRoute>
								<AdminLayout>
									<ComboManagement />
								</AdminLayout>
							</ProtectedRoute>
						} />
						<Route path="/admin/sellers" element={
							<ProtectedRoute>
								<AdminLayout>
									<SellersManagement />
								</AdminLayout>
							</ProtectedRoute>
						} />
						<Route path="/admin/database" element={
							<ProtectedRoute>
								<AdminLayout>
									<DatabaseManagement />
								</AdminLayout>
							</ProtectedRoute>
						} />
						<Route path="/admin/settings" element={
							<ProtectedRoute>
								<AdminLayout>
									<SettingsManagement />
								</AdminLayout>
							</ProtectedRoute>
						} />
						<Route path="/admin/direct-sales" element={
							<ProtectedRoute>
								<AdminLayout>
									<DirectSalesPage />
								</AdminLayout>
							</ProtectedRoute>
						} />

						{/* Seller Routes */}
						<Route path="/seller" element={<Navigate to="/login" replace />} />
						<Route path="/seller/dashboard" element={
							<SellerProtectedRoute>
								<SellerLayout>
									<SellerDashboard />
								</SellerLayout>
							</SellerProtectedRoute>
						} />
						<Route path="/seller/direct-sales" element={
							<SellerProtectedRoute>
								<SellerLayout>
									<DirectSalesPage />
								</SellerLayout>
							</SellerProtectedRoute>
						} />
					</Routes>

					{/* Toast Notifications */}
					<ToastContainer
						position="top-right"
						autoClose={5000}
						hideProgressBar={false}
						newestOnTop={false}
						closeOnClick
						rtl={false}
						pauseOnFocusLoss
						draggable
						pauseOnHover
						theme="light"
						toastClassName="vietnamese-text"
					/>
				</div>
			</CartProvider>
		</Router>
	);
}

export default App;
