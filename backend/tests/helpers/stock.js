/**
 * Apply pending stock movements the way the queue worker would, without Redis:
 * oldest first, through the real `applyMovement`. Orders only record movements,
 * so a test that asserts on `stockQuantity` has to run them first.
 */
const StockMovement = require('../../models/StockMovement');
const { applyMovement } = require('../../services/stock-ledger');

async function applyPendingMovements() {
	const pending = await StockMovement.find({ status: 'pending' }).sort({ createdAt: 1, _id: 1 }).select('_id').lean();
	for (const { _id } of pending) {
		await applyMovement(_id);
	}
}

module.exports = { applyPendingMovements };
