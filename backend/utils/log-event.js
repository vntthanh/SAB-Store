// Business events share the container log with access lines: one JSON object
// per line, told apart by `type`. Fields must stay free of personal data
// (names, ids, phones, emails, order and transaction codes) - the log leaves the
// database's access controls and is retained and searched elsewhere. The
// envelope keys are written last: a field named `type` would otherwise replace
// `type: 'event'` and hide the line from every query that filters on it.
function logEvent(event, fields = {}) {
	try {
		console.log(JSON.stringify({ ...fields, type: 'event', event }));
	} catch (err) {
		// Telemetry must never fail the request or the worker that emitted it.
		console.error('logEvent failed:', event, err.message);
	}
}

/** Fields of `order.created` for an order that has just committed. */
function orderCreatedFields({ channel, orderItems, totalAmount, comboInfo }) {
	return {
		channel,
		items: orderItems.reduce((sum, item) => sum + item.quantity, 0),
		totalAmount,
		comboApplied: Boolean(comboInfo)
	};
}

module.exports = { logEvent, orderCreatedFields };
