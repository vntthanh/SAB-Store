/**
 * The storefront a new product or combo starts in when the list filter is empty:
 * the only one, else the first active one. Empty when none qualifies, which leaves the
 * form's own required-field message to ask.
 */
export const pickDefaultStorefrontId = (storefronts) => {
	if (storefronts.length === 1) return storefronts[0]._id;
	return storefronts.find((storefront) => storefront.isActive)?._id ?? '';
};
