import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { comboService } from '../services/api';
import usePublicDetail from '../hooks/use-public-detail';
import ProductCard from '../components/ProductCard';
import ShareButton from '../components/ShareButton';
import NotFoundPage from './NotFoundPage';

const DetailSkeleton = () => (
	<div className="container mx-auto px-4 py-8 animate-pulse" aria-busy="true">
		<div className="h-8 bg-gray-200 rounded w-1/2 mb-4"></div>
		<div className="h-6 bg-gray-200 rounded w-1/4 mb-6"></div>
		<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
			{[0, 1, 2].map((key) => (
				<div key={key} className="h-72 bg-gray-200 rounded-lg"></div>
			))}
		</div>
	</div>
);

const ComboDetailPage = () => {
	const { code } = useParams();
	const { cart, formatCurrency } = useCart();

	const { data: combo, status, retry } = usePublicDetail(comboService.getByCode, code);

	if (status === 'loading') return <DetailSkeleton />;
	if (status === 'notfound') {
		return <NotFoundPage message="Combo không tồn tại hoặc đã ngừng bán" />;
	}
	if (status === 'error') {
		return (
			<div className="container mx-auto px-4 py-16 text-center">
				<h1 className="text-2xl font-bold text-gray-900 mb-4">Không tải được combo</h1>
				<button type="button" className="btn btn-primary" onClick={retry}>
					Thử lại
				</button>
			</div>
		);
	}

	// Any product of the requirement's category counts, since the combo is category-based.
	const pickedFor = (requirement) => {
		const ids = new Set((requirement.products || []).map((product) => product._id));
		return cart.items
			.filter((item) => ids.has(item.productId))
			.reduce((sum, item) => sum + item.quantity, 0);
	};

	return (
		<div className="container mx-auto px-4 py-8">
			<Link to="/" className="inline-block text-blue-700 hover:underline mb-4">
				← Về cửa hàng
			</Link>
			<div className="mb-6">
				<h1 className="text-2xl md:text-3xl font-bold text-gray-900 mb-2 break-words">{combo.name}</h1>
				<p className="text-2xl font-bold text-blue-600 mb-3">{formatCurrency(combo.price)}</p>
				{combo.description && (
					<p className="text-gray-700 mb-4 whitespace-pre-line break-words">{combo.description}</p>
				)}
				<div className="flex flex-wrap items-center gap-3">
					<ShareButton path={combo.path} title={combo.name} mode="share" />
					<ShareButton path={combo.path} title={combo.name} mode="copy" />
				</div>
			</div>

			<div className="space-y-8">
				{(combo.requirements || []).map((requirement) => {
					const products = requirement.products || [];
					return (
						<section key={requirement.category}>
							<div className="flex flex-wrap items-center justify-between gap-2 mb-3">
								<h2 className="text-lg font-semibold text-gray-900">
									Chọn {requirement.quantity} món từ {requirement.category}
								</h2>
								<span className="text-sm font-medium text-blue-600">
									{pickedFor(requirement)}/{requirement.quantity}
								</span>
							</div>
							{products.length === 0 ? (
								<p className="text-gray-600">Hiện chưa có sản phẩm nào để chọn cho combo này</p>
							) : (
								<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
									{products.map((product) => (
										<ProductCard key={product._id} product={product} />
									))}
								</div>
							)}
						</section>
					);
				})}
			</div>
		</div>
	);
};

export default ComboDetailPage;
