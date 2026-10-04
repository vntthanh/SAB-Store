const { computeOrderPricing } = require('../../services/pricing');

/** The total a client would have displayed: what the engine charges for `items` right now. */
async function expectedTotalFor(items, channel = 'online') {
	return (await computeOrderPricing(items, { channel })).totalAmount;
}

module.exports = { expectedTotalFor };
