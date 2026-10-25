import React from 'react';
import { Link } from 'react-router-dom';
import { useCart } from '../../context/CartContext';
import ProductCard from '../ProductCard';
import Cart from '../Cart';
import { comboPath } from '../../utils/share-links';

// Presentational: the page decides what the viewer may see; this only draws a
// storefront's combos, products and its own cart.
const CatalogView = ({ products, combos, canOrder = true }) => {
	const { getCartItemCount, getCartTotal, formatCurrency, comboDetection } = useCart();
	const cartItemCount = getCartItemCount();
	const cartTotal = getCartTotal();

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
				{/* Products Section */}
				<div className="xl:col-span-2">
					{/* Combo Offers Section */}
					{combos.length > 0 && (
						<div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-6 mb-8">
							<div className="flex items-center mb-4">
								<i className="fas fa-gift text-2xl text-blue-600 mr-3"></i>
								<h2 className="text-xl font-bold text-blue-800">Combo Ưu Đãi (Tự động áp dụng)</h2>
							</div>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
								{combos.map(combo => {
									// Legacy records without a public code have no detail page.
									const detailPath = combo.path ?? comboPath(combo);
									return (
										<div key={combo._id} className="bg-white rounded-lg p-4 border border-blue-100 shadow-sm">
											<div className="flex justify-between items-start mb-2">
												<h3 className="font-semibold text-gray-900">
													{detailPath ? (
														<Link to={detailPath} className="hover:text-blue-700 hover:underline">{combo.name}</Link>
													) : combo.name}
												</h3>
												<span className="text-lg font-bold text-blue-600">{formatCurrency(combo.price)}</span>
											</div>
											{combo.description && (
												<p className="text-sm text-gray-600 mb-3">{combo.description}</p>
											)}
											<div className="space-y-1">
												{combo.categoryRequirements.map((req, index) => (
													<div key={index} className="flex justify-between text-sm">
														<span className="text-gray-700">{req.category}</span>
														<span className="text-blue-600 font-medium">{req.quantity} sản phẩm</span>
													</div>
												))}
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* Combo Detection Warning */}
					{comboDetection.hasCombo && (
						<div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
							<div className="flex items-start">
								<i className="fas fa-gift text-green-500 mt-1 mr-3"></i>
								<div className="flex-1">
									<h3 className="font-semibold text-green-800 mb-1">Combo được áp dụng!</h3>
									<p className="text-green-700 text-sm">
										{comboDetection.message}
									</p>
									{comboDetection.combos.length > 0 && (
										<div className="mt-2 text-xs text-green-600">
											{comboDetection.combos.map((combo, index) => (
												<div key={index} className="flex justify-between">
													<span>{combo.comboName} x{combo.applications}</span>
													<span>-{formatCurrency(combo.savings)}</span>
												</div>
											))}
										</div>
									)}
								</div>
							</div>
						</div>
					)}

					{products.length === 0 ? (
						<div className="text-center py-12">
							<i className="fas fa-box-open text-6xl text-gray-300 mb-4"></i>
							<h3 className="text-xl font-semibold text-gray-900 mb-2">
								Chưa có sản phẩm
							</h3>
							<p className="text-gray-600 mb-4">
								Hiện tại chưa có sản phẩm nào được bán
							</p>
						</div>
					) : (
						<div className="space-y-8">
							<div>
								<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
									{products.map(product => (
										<ProductCard key={product._id} product={product} />
									))}
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Cart Sidebar - Increased width */}
				<div className="xl:col-span-1" id='cart-sidebar'>
					<div className="sticky top-24">
						<Cart />

						{/* Checkout Button */}
						{cartItemCount > 0 && (
							<div className="mt-6">
								{canOrder ? (
									<Link
										to="/checkout"
										className="btn-success w-full text-center block text-lg py-3"
									>
										<i className="fas fa-credit-card mr-2"></i>
										Xác nhận ({formatCurrency(cartTotal)})
									</Link>
								) : (
									<span
										aria-disabled="true"
										className="btn-success w-full text-center block text-lg py-3 opacity-50 cursor-not-allowed"
									>
										<i className="fas fa-credit-card mr-2"></i>
										Xác nhận ({formatCurrency(cartTotal)})
									</span>
								)}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};

export default CatalogView;
