const refId = (ref) => String(ref?._id || ref);

const lineProductId = (item) => refId(item.productId);

// A line without a variant (a product without options) is keyed by its product id.
export const draftLineKey = ({ productId, variantId }) => (variantId ? String(variantId) : String(productId));

// An order can hold the same variant as a combo line and as a loose line; the
// server prices units per variant, so the draft works on one line per variant.
export const toDraft = (items) => {
	const byKey = new Map();
	(items || []).forEach((item) => {
		const productId = lineProductId(item);
		const variantId = item.variantId ? refId(item.variantId) : undefined;
		const key = draftLineKey({ productId, variantId });
		const existing = byKey.get(key);
		if (existing) {
			existing.quantity += item.quantity;
		} else {
			byKey.set(key, {
				key,
				productId,
				...(variantId && { variantId }),
				productName: item.productName,
				...(item.variantLabel && { variantLabel: item.variantLabel }),
				quantity: item.quantity,
			});
		}
	});
	return [...byKey.values()];
};

export const draftSignature = (draft) =>
	draft
		.map((line) => `${line.key}:${line.quantity}`)
		.sort()
		.join('|');

// variantId goes out only for a line that has one: a product without options is sent without it.
export const draftToPayloadItems = (draft) =>
	draft.map(({ productId, variantId, quantity }) => ({
		productId,
		...(variantId && { variantId }),
		quantity,
	}));

export const hasOptions = (product) => Array.isArray(product?.options) && product.options.length > 0;

// Variants a line can be added with: active, and not archived.
export const activeVariants = (product) =>
	(product?.variants || []).filter((variant) => variant.isActive !== false && !variant.archivedAt);
