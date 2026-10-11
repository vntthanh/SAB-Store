/**
 * The "can be sold on this channel" rule as plain filters. Kept apart from the
 * repositories because the Product and Combo models build their query statics
 * from it, and a model cannot require a repository that requires the model.
 */

// Where a product (or combo) may be sold. 'all' is not a channel a sale happens
// on; it is a product allowing every channel.
const SALES_CHANNELS = ['all', 'online', 'offline'];
const SALE_CHANNELS = ['online', 'offline'];

/** Highest priority first, then newest: the order in which combos are offered. */
const COMBO_SELLABLE_SORT = { priority: -1, createdAt: -1 };

/** @throws {TypeError} when `channel` is not a channel a sale happens on */
function assertSaleChannel(channel) {
	if (!SALE_CHANNELS.includes(channel)) {
		throw new TypeError(`channel must be one of ${SALE_CHANNELS.join(', ')}; got ${String(channel)}`);
	}
}

// Documents written before salesChannel existed have no such key, and Mongoose
// defaults do not apply to queries, so a bare $in would silently drop them.
function channelClause(channel) {
	assertSaleChannel(channel);
	return { $or: [{ salesChannel: { $in: ['all', channel] } }, { salesChannel: { $exists: false } }] };
}

// The one rule for "can be sold on this channel". Every list or lookup that
// feeds a sale or a storefront goes through here so the channels cannot drift.
function sellableQuery(channel) {
	return { available: true, ...channelClause(channel) };
}

// $and keeps a caller filter's own $or (e.g. text search) from colliding with
// the channel $or.
function productSellableFilter(channel, filter = {}) {
	return { $and: [filter, sellableQuery(channel)] };
}

// Combos that may discount an order placed on `channel`. The products inside a
// combo must still be sellable on that channel; pricing checks that separately.
function comboSellableFilter(channel, filter = {}) {
	return { $and: [filter, { isActive: true }, channelClause(channel)] };
}

module.exports = {
	SALES_CHANNELS,
	COMBO_SELLABLE_SORT,
	assertSaleChannel,
	sellableQuery,
	productSellableFilter,
	comboSellableFilter
};
