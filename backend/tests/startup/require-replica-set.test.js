const { requireReplicaSet } = require('../../lib/require-replica-set');

const connectionReplying = (reply) => {
	const command = jest.fn().mockResolvedValue(reply);
	return { connection: { db: { admin: () => ({ command }) } }, command };
};

describe('requireReplicaSet', () => {
	it('throws on a standalone server (no setName)', async () => {
		const { connection, command } = connectionReplying({ isWritablePrimary: true });
		await expect(requireReplicaSet(connection)).rejects.toThrow(/not running as a replica set/);
		expect(command).toHaveBeenCalledWith({ hello: 1 });
	});

	it('resolves with the set name on a replica set', async () => {
		const { connection } = connectionReplying({ setName: 'rs0', isWritablePrimary: true });
		await expect(requireReplicaSet(connection)).resolves.toBe('rs0');
	});

	it('propagates a failing hello command instead of swallowing it', async () => {
		const connection = { db: { admin: () => ({ command: jest.fn().mockRejectedValue(new Error('boom')) }) } };
		await expect(requireReplicaSet(connection)).rejects.toThrow('boom');
	});

	it('passes against the harness replica set', async () => {
		const mongoose = require('mongoose');
		await expect(requireReplicaSet(mongoose.connection)).resolves.toEqual(expect.any(String));
	});
});
