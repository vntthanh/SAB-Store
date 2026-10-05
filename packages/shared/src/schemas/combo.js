import { z } from '../z.js';
import { arrayElement, mongoId, wholeNumber } from './primitives.js';

const ITEMS_RANGE = 'Danh sách sản phẩm phải có từ 1 đến 100 mục';

/**
 * The public cart preview. The array is bounded so an anonymous caller cannot
 * force an unbounded product lookup, and each quantity is bounded so it cannot
 * reach Infinity/NaN territory in pricing math. The order-wide unit cap is
 * enforced by the pricing engine, which sees lines after duplicates merge; its
 * per-line ceiling is passed in because that constant lives with the engine.
 */
export function makeComboItems({ maxUnits }) {
	return z.object({
		items: z
			.array(
				arrayElement({
					productId: mongoId('ID sản phẩm không hợp lệ'),
					quantity: wholeNumber({ min: 1, max: maxUnits, message: `Số lượng phải từ 1-${maxUnits}` }),
				}),
				{ error: ITEMS_RANGE },
			)
			.min(1, ITEMS_RANGE)
			.max(100, ITEMS_RANGE),
		// Read through the query-guard enum, which maps any unknown value to the
		// default channel, so no shape is refused here.
		channel: z.unknown().optional(),
	});
}
