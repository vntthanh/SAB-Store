/**
 * Refuses to run against a standalone mongod.
 *
 * Order and stock writes rely on multi-document transactions, which a standalone
 * server rejects at call time. The test harness is a replica set, so without
 * this check the mismatch would only surface in production, mid-request.
 */
async function requireReplicaSet(connection) {
	const hello = await connection.db.admin().command({ hello: 1 });
	if (!hello || !hello.setName) {
		throw new Error(
			'MongoDB is not running as a replica set (hello.setName is empty). ' +
			'Transactions require one: start mongod with --replSet and add replicaSet=<name> to MONGODB_URI.'
		);
	}
	return hello.setName;
}

module.exports = { requireReplicaSet };
