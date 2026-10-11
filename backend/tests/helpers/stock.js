/**
 * Apply pending stock movements the way the queue worker would, without Redis:
 * oldest first, through the real `applyMovement`. Orders only record movements,
 * so a test that asserts on `stockQuantity` has to run them first.
 */
const { applyMovement } = require('../../services/stock-ledger');
const { movements } = require('./db');

async function applyPendingMovements() {
	const pending = await movements({ status: 'pending' });
	for (const { _id } of pending) {
		await applyMovement(_id);
	}
}

module.exports = { applyPendingMovements };
