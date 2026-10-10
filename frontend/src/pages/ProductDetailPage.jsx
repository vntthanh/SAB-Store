import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCart, CART_MAX_QUANTITY } from '../context/CartContext';
import { productService } from '../services/api';
import usePublicDetail from '../hooks/use-public-detail';
import { getImageUrl } from '../utils/helpers';
import ShareButton from '../components/ShareButton';
import NotFoundPage from './NotFoundPage';

// Mirrors the cart's own ceiling so a detail-page quantity never exceeds what +/- can reach.

const DetailSkeleton = () => (
	<div className="container mx-auto px-4 py-8 animate-pulse" aria-busy="true">
		<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
			<div className="bg-gray-200 rounded-lg aspect-square"></div>
			<div className="space-y-4">
				<div className="h-8 bg-gray-200 rounded w-3/4"></div>
				<div className="h-6 bg-gray-200 rounded w-1/3"></div>
				<div className="h-24 bg-gray-200 rounded"></div>
				<div className="h-12 bg-gray-200 rounded"></div>
			</div>
		</div>
	</div>
);

const ProductDetailPage = () => {
	const { code } = useParams();
	const { addToCart, formatCurrency } = useCart();

	const { data: product, status, retry } = usePublicDetail(productService.getByCode, code);
	const [quantity, setQuantity] = useState(1);

	// Each loaded product restarts at its own minimum order quantity.
	useEffect(() => {
		if (product) setQuantity(Math.max(1, product.minOrderQuantity || 1));
	}, [product]);

	const min = Math.max(1, product?.minOrderQuantity || 1);
	// A max below the min would leave no valid quantity, so the min wins.
	const max = Math.max(min, Math.min(CART_MAX_QUANTITY, product?.maxOrderQuantity || CART_MAX_QUANTITY));

	const clamp = useCallback((value) => {
		const number = Number.parseInt(value, 10);
		if (Number.isNaN(number)) return min;
		return Math.min(max, Math.max(min, number));
	}, [min, max]);

	// The field may hold '' while the customer is typing; step from 0 then.
	const step = (delta) => setQuantity((q) => clamp((Number.parseInt(q, 10) || 0) + delta));

	if (status === 'loading') return <DetailSkeleton />;
	if (status === 'notfound') {
		return <NotFoundPage message="Sản phẩm không tồn tại hoặc đã ngừng bán" />;
	}
	if (status === 'error') {
		return (
			<div className="container mx-auto px-4 py-16 text-center">
				<h1 className="text-2xl font-bold text-gray-900 mb-4">Không tải được sản phẩm</h1>
				<button type="button" className="btn btn-primary" onClick={retry}>
					Thử lại
				</button>
			</div>
		);
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<Link to="/" className="inline-block text-blue-700 hover:underline mb-4">
				← Về cửa hàng
			</Link>
			<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
				<img
					src={getImageUrl(product.imageUrl)}
					alt={product.name}
					className="w-full rounded-lg object-cover aspect-square bg-gray-100"
					onError={(e) => {
						e.target.onerror = null;
						e.target.src = '/fallback-product.png';
					}}
				/>
				<div className="min-w-0">
					{product.category && <span className="badge-primary">{product.category}</span>}
					<h1 className="text-2xl md:text-3xl font-bold text-gray-900 mt-2 mb-3 break-words">
						{product.name}
					</h1>
					<p className="text-2xl font-bold text-primary-600 mb-4">{formatCurrency(product.price)}</p>
					{product.description && (
						<p className="text-gray-700 mb-6 whitespace-pre-line break-words">{product.description}</p>
					)}

					{product.available && (
						<div className="flex items-center gap-3 mb-4">
							<span className="text-gray-700">Số lượng</span>
							<div className="flex items-center">
								<button
									type="button"
									className="btn btn-secondary w-10 h-10 flex items-center justify-center p-0"
									onClick={() => step(-1)}
									disabled={quantity <= min}
									aria-label="Giảm số lượng"
								>
									<i className="fas fa-minus"></i>
								</button>
								<input
									type="number"
									inputMode="numeric"
									min={min}
									max={max}
									value={quantity}
									onChange={(e) => setQuantity(e.target.value)}
									onBlur={() => setQuantity(clamp(quantity))}
									aria-label="Số lượng"
									className="w-16 h-10 mx-2 text-center rounded-lg border border-gray-300"
								/>
								<button
									type="button"
									className="btn btn-secondary w-10 h-10 flex items-center justify-center p-0"
									onClick={() => step(1)}
									disabled={quantity >= max}
									aria-label="Tăng số lượng"
								>
									<i className="fas fa-plus"></i>
								</button>
							</div>
						</div>
					)}

					<div className="flex flex-wrap items-center gap-3">
						{product.available && (
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => addToCart(product, clamp(quantity))}
							>
								<i className="fas fa-plus mr-2"></i>
								Thêm vào giỏ
							</button>
						)}
						<ShareButton path={product.path} title={product.name} mode="share" />
						<ShareButton path={product.path} title={product.name} mode="copy" />
					</div>
				</div>
			</div>
		</div>
	);
};

export default ProductDetailPage;
