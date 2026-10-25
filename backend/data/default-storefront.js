/**
 * The storefront every product, and every online order, belonged to before
 * storefronts existed. Its row is inserted by the storefronts migration with this
 * id (a test keeps the two equal), so the id is a fixed constant instead of
 * something looked up: the snapshot restore, the Mongo stand-in and the test
 * helpers all need it without a database round-trip.
 */
const DEFAULT_STOREFRONT_ID = '01a173f3-7280-71fd-b24f-118da6196e35';
const DEFAULT_STOREFRONT_SLUG = 'cua-hang';
const DEFAULT_STOREFRONT_NAME = 'Cửa hàng';

module.exports = { DEFAULT_STOREFRONT_ID, DEFAULT_STOREFRONT_SLUG, DEFAULT_STOREFRONT_NAME };
