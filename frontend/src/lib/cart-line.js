// A cart line is one product, or one variant of a product that has options. A product without
// options never carries a variantId, so a cart saved before variants existed keeps merging with new adds.
export const lineKey = ({ productId, variantId }) => `${productId}:${variantId ?? ''}`;

// The server's view of a line: the variant only goes along when the line has one.
export const toRequestItem = ({ productId, variantId, quantity }) =>
	variantId ? { productId, variantId, quantity } : { productId, quantity };

/**
 * The cart lines a VARIANT_REQUIRED / VARIANT_UNAVAILABLE answer names in `details.lines`.
 * Sibling variants of the same product are not named, so they stay.
 */
export const linesNamedByError = (items, details) => {
	const named = new Set(
		(Array.isArray(details?.lines) ? details.lines : [])
			.filter((line) => line && typeof line.productId === 'string')
			.map(lineKey)
	);
	return named.size === 0 ? [] : items.filter((item) => named.has(lineKey(item)));
};

/** Product name with the variant label, for toasts. */
export const lineTitle = (item) => (item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName);
