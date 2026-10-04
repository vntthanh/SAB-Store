import React from 'react';
import { Link } from 'react-router-dom';
import { useCart, CART_MAX_QUANTITY } from '../context/CartContext';
import { getImageUrl } from '../utils/helpers';
import { productPath } from '../utils/share-links';

// Defined at module level so a re-render does not remount the image.
const DetailLink = ({ to, className, children }) =>
	to ? <Link to={to} className={className}>{children}</Link> : <div className={className}>{children}</div>;

const ProductCard = ({ product }) => {
	const {
		addToCart,
		increaseQuantity,
		decreaseQuantity,
		getItemQuantity,
		formatCurrency
	} = useCart();

	const quantity = getItemQuantity(product._id);
	// Docs without a public code yet (before backfill) have no detail page to link to.
	const detailPath = product.path ?? productPath(product);

	const handleAddToCart = () => {
		addToCart(product);
	};

	const handleIncrease = (e) => {
		e.stopPropagation();
		increaseQuantity(product._id);
	};

	const handleDecrease = (e) => {
		e.stopPropagation();
		decreaseQuantity(product._id);
	};

	return (
		<div className="card-hover group flex flex-col h-full">
			{/* Product Image */}
			<DetailLink to={detailPath} className="relative block overflow-hidden h-48">
				<img
					src={getImageUrl(product.imageUrl)}
					alt={product.name}
					className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
					onError={(e) => {
						e.target.onerror = null;
						e.target.src = '/fallback-product.png';
					}}
				/>
				{/* Category Badge */}
				<div className="absolute top-3 left-3">
					<span className="badge-primary">
						{product.category}
					</span>
				</div>
			</DetailLink>
			{/* Product Info */}
			<div className="p-4 flex flex-col flex-1">
				<h3 className="font-semibold text-lg text-gray-900 mb-2 line-clamp-1">
					<DetailLink to={detailPath} className="hover:text-primary-600">
						{product.name}
					</DetailLink>
				</h3>
				<p className="text-gray-600 text-sm mb-3 line-clamp-2">
					{product.description}
				</p>
				<div className="flex items-center justify-between mb-4">
					<span className="text-xl font-bold text-primary-600">
						{formatCurrency(product.price)}
					</span>
				</div>
				<div className="flex-1"></div>
				{/* Add to Cart Controls */}
				{product.available && (
					<div className="flex items-center justify-between mt-4">
						{quantity === 0 ? (
							<button
								onClick={handleAddToCart}
								className="btn-primary w-full"
							>
								<i className="fas fa-plus mr-2"></i>
								Thêm vào giỏ
							</button>
						) : (
							<div className="flex items-center justify-between w-full">
								<button
									onClick={handleDecrease}
									className="btn-secondary w-10 h-10 flex items-center justify-center p-0"
								>
									<i className="fas fa-minus"></i>
								</button>
								<div className="flex-1 text-center">
									<span className="text-lg font-semibold text-gray-900">
										{quantity}
									</span>
									<div className="text-xs text-gray-500">
										{formatCurrency(product.price * quantity)}
									</div>
								</div>
								<button
									onClick={handleIncrease}
									className="btn-primary w-10 h-10 flex items-center justify-center p-0"
									disabled={quantity >= CART_MAX_QUANTITY}
								>
									<i className="fas fa-plus"></i>
								</button>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
};

export default ProductCard;
