import React from 'react';
import Lightbox from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';

const LABELS = {
	Previous: 'Ảnh trước',
	Next: 'Ảnh sau',
	Close: 'Đóng',
	'Zoom in': 'Phóng to',
	'Zoom out': 'Thu nhỏ',
	Lightbox: 'Xem ảnh lớn',
	'Photo gallery': 'Ảnh sản phẩm',
	Slide: 'Ảnh',
	Carousel: 'Bộ ảnh',
	'{index} of {total}': 'Ảnh {index}/{total}'
};

/** Fullscreen viewer with pinch/double-tap zoom; loaded only when a shopper opens it. */
const ProductImageViewer = ({ slides, index, onView, onClose }) => (
	<Lightbox
		open
		close={onClose}
		index={index}
		slides={slides}
		labels={LABELS}
		on={{ view: ({ index: viewed }) => onView(viewed) }}
		plugins={[Zoom]}
		// The default stops zooming at the file's own resolution, which on a phone is barely past fit.
		zoom={{ maxZoomPixelRatio: 4 }}
		carousel={{ finite: slides.length <= 1 }}
		render={slides.length <= 1 ? { buttonPrev: () => null, buttonNext: () => null } : undefined}
	/>
);

export default ProductImageViewer;
