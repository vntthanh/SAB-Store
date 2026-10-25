export const storefrontPath = (slug) => `/s/${encodeURIComponent(slug)}`;

/** The tab `/` opens: the first one the viewer can enter, else the first (its gate asks for sign-in). */
export const pickLandingSlug = (storefronts) => {
	if (!Array.isArray(storefronts) || storefronts.length === 0) return null;
	return (storefronts.find((storefront) => storefront.accessible) ?? storefronts[0]).slug;
};

const STOREFRONT_GATE_CODES = ['STOREFRONT_LOGIN_REQUIRED', 'STOREFRONT_FORBIDDEN'];

/** True for the 401/403 a private storefront answers an unadmitted viewer with. */
export const isGateError = (error) =>
	Boolean(error) && (error.status === 401 || error.status === 403) && STOREFRONT_GATE_CODES.includes(error.code);

/** The access errors checkout reacts to by sending the customer back to the storefront. */
export const isStorefrontAccessError = (error) =>
	Boolean(error) && typeof error.code === 'string' && (error.code.startsWith('STOREFRONT_') || error.code === 'ORDER_MIXED_STOREFRONTS');
