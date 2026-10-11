/** A lean document as a plain record: the id becomes a string (see data/index.js). */
function withStringId(doc) {
	return { ...doc, _id: String(doc._id) };
}

/**
 * A hydrated document as a plain record, with the schema defaults applied (a
 * lean read skips them) and serialising exactly as the document itself would.
 */
function toRecord(doc) {
	return withStringId(doc.toJSON());
}

module.exports = { withStringId, toRecord };
