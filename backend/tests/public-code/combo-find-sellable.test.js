const { combos } = require('../../data');
const { makeCombo } = require('../helpers/factories');

describe('combos.findSellable', () => {
	it('works without a filter and with one, and drops combos of the other channel', async () => {
		const online = await makeCombo({ salesChannel: 'online' });
		const offline = await makeCombo({ salesChannel: 'offline' });

		const all = await combos.findSellable('online');
		expect(all.map((c) => c._id.toString())).toEqual([online._id.toString()]);

		const filtered = await combos.findSellable('online', { publicCode: online.publicCode });
		expect(filtered).toHaveLength(1);
		expect(await combos.findSellable('online', { publicCode: offline.publicCode })).toHaveLength(0);
	});
});
