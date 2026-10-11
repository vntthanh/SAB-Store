/**
 * The pieces of the public-code backfill that touch storage, for one model.
 * Spread into the products and combos repositories.
 *
 * Reads and writes go through the raw driver because `publicCode` is immutable
 * (a Mongoose save cannot add it to an old document) and because the state to
 * find is "the field does not exist", which a hydrated read would paper over
 * with a default. Rows are plain records (string `_id`).
 */
const mongoose = require('mongoose');
const { withStringId } = require('./records');
const { assignMissingPublicCode } = require('../../utils/public-code');

function publicCodeBackfill(Model) {
	return {
		/** The number of rows. */
		count() {
			return Model.countDocuments({});
		},

		/**
		 * Id and name of every row that has no `publicCode`. Read up front: writing
		 * while a cursor over the same filter is open can skip rows.
		 *
		 * @returns {Promise<Array<{_id: string, name: string}>>}
		 */
		async listWithoutPublicCode() {
			const rows = await Model.collection
				.find({ publicCode: { $exists: false } }, { projection: { _id: 1, name: 1 } })
				.toArray();
			return rows.map(withStringId);
		},

		/**
		 * Give the row its code and slug. Guarded on the field still being absent, so
		 * a re-run or a concurrent run assigns nothing twice; `updatedAt` is left alone.
		 *
		 * @param {{_id: string, name: string}} row
		 * @returns {Promise<boolean>} true when this call wrote the code
		 */
		assignMissingPublicCode(row) {
			return assignMissingPublicCode(Model, { _id: new mongoose.Types.ObjectId(row._id), name: row.name });
		},

		/** Build the unique `publicCode` index; uniqueness would rest on chance without it. */
		async ensureIndexes() {
			await Model.init();
		}
	};
}

module.exports = { publicCodeBackfill };
