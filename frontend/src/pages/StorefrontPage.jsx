import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useCart } from '../context/CartContext';
import { getStorefrontCatalog } from '../services/api';
import { useAuthIdentity, useStorefronts } from '../lib/use-storefronts';
import { isGateError } from '../lib/storefront-tabs';
import LoadingSpinner from '../components/LoadingSpinner';
import StorefrontTabs from '../components/shop/StorefrontTabs';
import CatalogView from '../components/shop/CatalogView';
import PrivateStorefrontGate from '../components/shop/PrivateStorefrontGate';
import NotFoundPage from './NotFoundPage';

const PREVIEW_BANNER = 'Chế độ xem trước — tài khoản này không nằm trong danh sách được đặt hàng';

const StorefrontPage = () => {
	const { slug } = useParams();
	const identity = useAuthIdentity();
	const { storefronts, reload: reloadStorefronts } = useStorefronts();
	const { setActiveStorefront } = useCart();
	const [reloadKey, setReloadKey] = useState(0);

	// loading | ready | gated | notfound | error, valid only for `result.requestKey`:
	// after a tab or sign-in change the previous answer is never shown for the new one.
	const requestKey = `${slug}|${identity.key}|${reloadKey}`;
	const [result, setResult] = useState({ requestKey: null, status: 'loading', data: null, error: null });

	useEffect(() => {
		let active = true;
		getStorefrontCatalog(slug)
			.then((response) => {
				if (!active) return;
				if (!response?.storefront) {
					setResult({ requestKey, status: 'notfound', data: null, error: null });
					return;
				}
				setResult({ requestKey, status: 'ready', data: response, error: null });
			})
			.catch((error) => {
				if (!active) return;
				if (isGateError(error)) {
					setResult({ requestKey, status: 'gated', data: null, error });
				} else if (error.status === 404 || error.code === 'STOREFRONT_NOT_FOUND') {
					setResult({ requestKey, status: 'notfound', data: null, error });
				} else {
					toast.error(error.message);
					setResult({ requestKey, status: 'error', data: null, error });
				}
			});
		return () => {
			active = false;
		};
	}, [slug, requestKey]);

	// Granting access changes the tabs' lock flags too, not only this catalog.
	const retry = useCallback(() => {
		setReloadKey((key) => key + 1);
		reloadStorefronts();
	}, [reloadStorefronts]);

	const current = result.requestKey === requestKey;
	const status = current ? result.status : 'loading';
	const data = current && status === 'ready' ? result.data : null;
	const canOrder = data ? data.canOrder !== false : true;

	// The cart and add buttons follow the storefront on screen.
	useEffect(() => {
		if (data?.storefront?.id) {
			setActiveStorefront({ ...data.storefront, canOrder: data.canOrder !== false });
		}
	}, [data, setActiveStorefront]);

	useEffect(() => {
		if (!data) return undefined;
		const previous = document.title;
		document.title = data.storefront.name;
		return () => {
			document.title = previous;
		};
	}, [data]);

	if (status === 'notfound') {
		return <NotFoundPage message="Gian hàng không tồn tại hoặc đã ngừng hoạt động" />;
	}

	let content;
	if (status === 'loading') {
		content = (
			<div className="flex min-h-[40vh] items-center justify-center">
				<LoadingSpinner size="large" text="Đang tải sản phẩm..." />
			</div>
		);
	} else if (status === 'gated') {
		content = <PrivateStorefrontGate storefront={result.error.storefront} error={result.error} onAccessChanged={retry} />;
	} else if (status === 'error') {
		content = (
			<div className="flex min-h-[40vh] items-center justify-center">
				<div className="text-center">
					<i className="fas fa-exclamation-triangle text-6xl text-danger-500 mb-4"></i>
					<h2 className="text-2xl font-bold text-gray-900 mb-2">Có lỗi xảy ra</h2>
					<p className="text-gray-600 mb-4">{result.error?.message}</p>
					<button type="button" onClick={retry} className="btn-primary">
						Thử lại
					</button>
				</div>
			</div>
		);
	} else {
		content = (
			<>
				{!canOrder && (
					<div className="border-b border-yellow-200 bg-yellow-50" role="status">
						<p className="container mx-auto px-4 py-3 text-sm text-yellow-800">
							<i className="fas fa-eye mr-2"></i>
							{PREVIEW_BANNER}
						</p>
					</div>
				)}
				<CatalogView products={data.products} combos={data.combos ?? []} canOrder={canOrder} />
			</>
		);
	}

	return (
		<>
			<StorefrontTabs storefronts={storefronts} activeSlug={slug} />
			{content}
		</>
	);
};

export default StorefrontPage;
