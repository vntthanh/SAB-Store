import React, { useEffect, useState } from 'react';
import { getImageUrl } from '../../utils/helpers';

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

	useEffect(() => {
		const position = focusImage ? images.indexOf(focusImage) : -1;
		if (position >= 0) setIndex(position);
	}, [focusImage, images]);

	// A new product (or a shorter gallery) must not leave the cover pointing past the end.
	const current = images[Math.min(index, images.length - 1)] ?? null;

	return (
		<div className="min-w-0">
			<img
				src={getImageUrl(current)}
				alt={alt}
				className="w-full rounded-lg object-cover aspect-square bg-gray-100"
				onError={showFallback}
			/>
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
