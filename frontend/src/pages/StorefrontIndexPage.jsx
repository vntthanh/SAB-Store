import React from 'react';
import { Navigate } from 'react-router-dom';
import { useStorefronts } from '../lib/use-storefronts';
import { pickLandingSlug, storefrontPath } from '../lib/storefront-tabs';
import LoadingSpinner from '../components/LoadingSpinner';

// "/" has no content of its own: it opens the first storefront the viewer can enter.
const StorefrontIndexPage = () => {
	const { status, storefronts, error, reload } = useStorefronts();

	if (status === 'loading') {
		return (
			<div className="flex min-h-[50vh] items-center justify-center">
				<LoadingSpinner size="large" text="Đang tải gian hàng..." />
			</div>
		);
	}

	if (status === 'error') {
		return (
			<div className="container mx-auto px-4 py-16 text-center">
				<i className="fas fa-exclamation-triangle text-6xl text-danger-500 mb-4"></i>
				<h1 className="text-2xl font-bold text-gray-900 mb-2">Không tải được gian hàng</h1>
				<p className="text-gray-600 mb-4">{error?.message}</p>
				<button type="button" onClick={reload} className="btn-primary">
					Thử lại
				</button>
			</div>
		);
	}

	const slug = pickLandingSlug(storefronts);
	if (!slug) {
		return (
			<div className="container mx-auto px-4 py-16 text-center">
				<i className="fas fa-store-slash text-6xl text-gray-300 mb-4"></i>
				<h1 className="text-2xl font-bold text-gray-900 mb-2">Chưa có gian hàng nào đang mở</h1>
				<p className="text-gray-600">Vui lòng quay lại sau.</p>
			</div>
		);
	}

	return <Navigate to={storefrontPath(slug)} replace />;
};

export default StorefrontIndexPage;
