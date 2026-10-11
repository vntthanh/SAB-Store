/** A lean document as a plain record: the id becomes a string (see data/index.js). */
function withStringId(doc) {
	return { ...doc, _id: String(doc._id) };
}

module.exports = { withStringId };
