/**
 * The sales channels, independent of the store. 'all' is not a channel a sale
 * happens on; it is a product (or combo) allowing every channel.
 */
const SALES_CHANNELS = ['all', 'online', 'offline'];
const SALE_CHANNELS = ['online', 'offline'];

/** @throws {TypeError} when `channel` is not a channel a sale happens on */
function assertSaleChannel(channel) {
	if (!SALE_CHANNELS.includes(channel)) {
		throw new TypeError(`channel must be one of ${SALE_CHANNELS.join(', ')}; got ${String(channel)}`);
	}
}

module.exports = { SALES_CHANNELS, assertSaleChannel };
