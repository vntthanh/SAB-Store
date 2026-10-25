const SLUG_MAX_LENGTH = 60;

// `đ` has no Unicode decomposition, so stripping combining marks alone would drop it.
// The result satisfies the shared storefrontSlug pattern (lowercase labels joined by single hyphens).
export const slugify = (text) => {
	const slug = String(text ?? '')
		.replace(/đ/g, 'd')
		.replace(/Đ/g, 'D')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, SLUG_MAX_LENGTH);
	return slug.replace(/-+$/, '');
};
