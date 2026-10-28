// A choice is an array parallel to product.options: the picked value of each option, or null.

// A product on the Mongo rollback store has options [] and no variants: it counts as without options.
export const hasOptions = (product) => Array.isArray(product?.options) && product.options.length > 0;

const variantsOf = (product) => (Array.isArray(product?.variants) ? product.variants : []);

export const emptyChoice = (product) => (hasOptions(product) ? product.options.map(() => null) : []);

const matchesPartial = (variant, choice, skipIndex = -1) =>
	choice.every((value, index) => index === skipIndex || value == null || variant.optionValues[index] === value);

/** Active variants consistent with whatever has been picked so far. */
export const matchingVariants = (product, choice) =>
	variantsOf(product).filter((variant) => matchesPartial(variant, choice));

/** The variant for a full choice, or null while an option is unpicked or the combination is not offered. */
export const chosenVariant = (product, choice) => {
	if (!hasOptions(product) || choice.length !== product.options.length || choice.some((value) => value == null)) {
		return null;
	}
	return matchingVariants(product, choice)[0] ?? null;
};

/** A chip is available when an active variant has this value together with the other current picks. */
export const isValueAvailable = (product, choice, optionIndex, value) =>
	variantsOf(product).some(
		(variant) => variant.optionValues[optionIndex] === value && matchesPartial(variant, choice, optionIndex)
	);

/** Picking the same value again clears it. */
export const pickValue = (choice, optionIndex, value) =>
	choice.map((current, index) => (index === optionIndex ? (current === value ? null : value) : current));

/** Lowest and highest unit price among the variants still possible; the product price when it has none. */
export const priceRange = (product, choice = []) => {
	const prices = (hasOptions(product) ? matchingVariants(product, choice) : [])
		.map((variant) => variant.effectivePrice)
		.filter((price) => Number.isFinite(price));
	if (prices.length === 0) return { min: product.price, max: product.price };
	return { min: Math.min(...prices), max: Math.max(...prices) };
};

/** "10.000 ₫" or "10.000 ₫ – 20.000 ₫". */
export const formatPriceRange = ({ min, max }, formatCurrency) =>
	min === max ? formatCurrency(min) : `${formatCurrency(min)} – ${formatCurrency(max)}`;
