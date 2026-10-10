import React from 'react';
import { useCart } from '../context/CartContext';
import { getImageUrl } from '../utils/helpers';

const Cart = () => {
	const {
		cart,
		increaseQuantity,
		decreaseQuantity,
		getCartTotal,
		getCartItemCount,
		formatCurrency,
		clearCart,
		comboDetection
	} = useCart();

	const total = getCartTotal();
	const itemCount = getCartItemCount();

	if (itemCount === 0) {
		return (
			<div className="card">
				<div className="p-6 text-center">
					<i className="fas fa-shopping-cart text-6xl text-gray-300 mb-4"></i>
					<h3 className="text-lg font-semibold text-gray-900 mb-2">
						Giỏ hàng trống
					</h3>
					<p className="text-gray-600 text-sm">
						Thêm sản phẩm vào giỏ hàng để bắt đầu đặt hàng
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="card">
			{/* Cart Header */}
			<div className="bg-primary-50 px-6 py-4 border-b border-primary-100">
				<div className="flex items-center justify-between">
					<h3 className="text-lg font-semibold text-gray-900">
						<i className="fas fa-shopping-cart mr-2 text-primary-600"></i>
						Giỏ hàng ({itemCount} món)
					</h3>
					<button
						onClick={clearCart}
						className="text-danger-600 hover:text-danger-700 text-sm"
						title="Xóa tất cả"
					>
						<i className="fas fa-trash"></i>
					</button>
				</div>
			</div>

			{/* Cart Items */}
			<div className="p-4 max-h-96 overflow-y-auto">
				<div className="space-y-4">
					{cart.items.map(item => (
						<div key={item.productId} className="flex items-center space-x-3 p-3 bg-gray-50 rounded-lg">
							{/* Product Image */}
							<img
								src={getImageUrl(item.image)}
								alt={item.productName}
								className="w-14 h-14 object-cover rounded-lg flex-shrink-0"
								onError={(e) => {
									e.target.src = '/fallback-product.png';
								}}
							/>

							{/* Product Info */}
							<div className="flex-1 min-w-0">
								<h4 className="font-medium text-gray-900 text-sm line-clamp-2 mb-1">
									{item.productName}
								</h4>
								<p className="text-primary-600 font-semibold text-sm">
									{formatCurrency(item.price)}
								</p>
							</div>

							{/* Quantity Controls */}
							<div className="flex flex-col items-center space-y-2">
								<div className="flex items-center space-x-2">
									<button
										onClick={() => decreaseQuantity(item.productId)}
										className="w-7 h-7 bg-gray-200 hover:bg-gray-300 rounded-full flex items-center justify-center transition-colors"
									>
										<i className="fas fa-minus text-xs"></i>
									</button>

									<span className="w-8 text-center font-semibold text-gray-900 text-sm">
										{item.quantity}
									</span>

									<button
										onClick={() => increaseQuantity(item.productId)}
										className="w-7 h-7 bg-primary-200 hover:bg-primary-300 rounded-full flex items-center justify-center transition-colors"
										disabled={item.quantity >= 99}
									>
										<i className="fas fa-plus text-xs"></i>
									</button>
								</div>
							</div>
						</div>
					))}
				</div>
			</div>

			{/* Combo Notification */}
			{comboDetection.hasCombo && (
				<div className="mx-4 mb-4">
					<div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-3">
						<div className="flex items-start space-x-2">
							<div className="flex-shrink-0">
								<i className="fas fa-gift text-green-600 text-lg"></i>
							</div>
							<div className="flex-1">
								<div className="text-sm">
									<p className="font-semibold text-green-800 mb-1">
										🎉 Combo khuyến mãi!
									</p>
									<p className="text-green-700 leading-relaxed">
										{comboDetection.message}
									</p>
								</div>
							</div>
						</div>
					</div>
				</div>
			)}

			{comboDetection.isChecking && (
				<div className="mx-4 mb-4">
					<div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
						<div className="flex items-center space-x-2">
							<div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
							<span className="text-sm text-blue-700">Đang kiểm tra combo...</span>
						</div>
					</div>
				</div>
			)}

			{/* Cart Summary */}
			<div className="border-t border-gray-200 p-4 space-y-3">
				{/* Original subtotal if combo is applied */}
				{comboDetection.hasCombo && comboDetection.combo && (
					<div className="flex justify-between items-center text-sm">
						<span className="text-gray-500 line-through">Giá gốc:</span>
						<span className="text-gray-500 line-through">
							{formatCurrency(cart.items.reduce((total, item) => total + (item.price * item.quantity), 0))}
						</span>
					</div>
				)}

				{/* Combo discount */}
				{comboDetection.hasCombo && comboDetection.savings > 0 && (
					<div className="flex justify-between items-center text-sm">
						<span className="text-green-600">Giảm giá combo:</span>
						<span className="text-green-600 font-medium">
							-{formatCurrency(comboDetection.savings)}
						</span>
					</div>
				)}

				{/* Current total */}
				<div className="flex justify-between items-center text-sm">
					<span className="text-gray-600">
						{comboDetection.hasCombo ? 'Giá combo:' : 'Tạm tính:'}
					</span>
					<span className="font-medium text-gray-900">
						{formatCurrency(total)}
					</span>
				</div>

				{/* Total */}
				<div className="flex justify-between items-center text-lg font-bold border-t pt-3">
					<span className="text-gray-900">Tổng cộng:</span>
					<span className={comboDetection.hasCombo ? "text-green-600" : "text-primary-600"}>
						{formatCurrency(total)}
					</span>
				</div>
			</div>
		</div>
	);
};

export default Cart;
