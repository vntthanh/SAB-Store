// Tests the Combo model's own static, so it calls the model directly; it moves
// with the static when the catalogue queries move behind the repository.
const Combo = require('../../models/Combo');
const { makeCombo } = require('../helpers/factories');

describe('Combo.findSellable', () => {
	it('works without a filter and with one, and drops combos of the other channel', async () => {
		const online = await makeCombo({ salesChannel: 'online' });
		const offline = await makeCombo({ salesChannel: 'offline' });

		const all = await Combo.findSellable('online');
		expect(all.map((c) => c._id.toString())).toEqual([online._id.toString()]);

		const filtered = await Combo.findSellable('online', { publicCode: online.publicCode });
		expect(filtered).toHaveLength(1);
		expect(await Combo.findSellable('online', { publicCode: offline.publicCode })).toHaveLength(0);
	});
});
