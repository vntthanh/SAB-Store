import React, { Suspense, lazy, useEffect, useState } from 'react';
import { getImageUrl } from '../../utils/helpers';

const ProductImageViewer = lazy(() => import('./ProductImageViewer'));

const showFallback = (e) => {
	e.target.onerror = null;
	e.target.src = '/fallback-product.png';
};

/**
 * Cover image plus a thumbnail strip. `focusImage` is the chosen variant's image: when it is part
 * of the gallery the cover jumps to it; a variant without an image leaves the cover where it is.
 */
const ProductGallery = ({ images, alt, focusImage }) => {
	const [index, setIndex] = useState(0);
	const [viewerOpen, setViewerOpen] = useState(false);

	useEffect(() => {
		const position = focusImage ? images.indexOf(focusImage) : -1;
		if (position >= 0) setIndex(position);
	}, [focusImage, images]);

	// A new product (or a shorter gallery) must not leave the cover pointing past the end.
	const currentIndex = Math.max(0, Math.min(index, images.length - 1));
	const current = images[currentIndex] ?? null;

	return (
		<div className="min-w-0">
			{/* The square cover crops landscape images such as size charts; the viewer shows them whole. */}
			<button
				type="button"
				onClick={() => setViewerOpen(true)}
				aria-label={`Xem ảnh lớn: ${alt}`}
				className="relative block w-full cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
			>
				<img
					src={getImageUrl(current)}
					alt={alt}
					className="w-full rounded-lg object-cover aspect-square bg-gray-100"
					onError={showFallback}
				/>
				<span className="absolute bottom-2 right-2 rounded-full bg-black/50 px-2 py-1 text-xs text-white" aria-hidden="true">
					<i className="fas fa-search-plus" />
				</span>
			</button>
			{viewerOpen && (
				<Suspense fallback={null}>
					<ProductImageViewer
						slides={(images.length ? images : [current]).map((image) => ({ src: getImageUrl(image), alt }))}
						index={currentIndex}
						onView={setIndex}
						onClose={() => setViewerOpen(false)}
					/>
				</Suspense>
			)}
			{images.length > 1 && (
				<div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Ảnh sản phẩm">
					{images.map((image, position) => (
						<button
							key={image}
							type="button"
							role="tab"
							aria-selected={image === current}
							aria-label={`Ảnh ${position + 1}`}
							onClick={() => setIndex(position)}
							className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors ${
								image === current ? 'border-primary-600' : 'border-transparent hover:border-gray-300'
							}`}
						>
							<img
								src={getImageUrl(image)}
								alt=""
								className="w-full h-full object-cover"
								onError={showFallback}
							/>
						</button>
					))}
				</div>
			)}
		</div>
	);
};

export default ProductGallery;
