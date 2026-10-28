/**
 * Saving a product's options and variants on Postgres, as the admin form sends
 * them (validated by `productVariantSetup` in @sab/shared).
 *
 * A variant keeps its id, and so its stock and its history, for as long as its
 * combination survives an edit: renaming an option or a value (`previousName`,
 * `previousValues`) rewrites the labels of the variants that carry it; adding an
 * option gives every existing variant the option's first value; removing one
 * folds variants that become equal into the first of them. A variant whose
 * combination is gone is deleted only when nothing ever referenced it (no stock
 * movement, no order line); otherwise it is archived (inactive, labels kept) and
 * comes back if its combination is offered again.
 *
 * Stock caches are never written here except on a product being created, where a
 * variant's opening balance is set together with its product's; the caller
 * records the matching applied `opening` movements in the same transaction.
 */
const { RecordValidationError, DuplicateKeyError } = require('../errors');
const { recordId } = require('./rules');
const { translating } = require('./errors');

const keyOf = (values) => JSON.stringify(values);

/**
 * Lock every variant of a product, in id order, before anything writes the
 * product row: the stock ledger locks a variant and then its product, so a writer
 * that took the product first could deadlock against it.
 *
 * @param {string} productId
 * @param {object} tx
 */
async function lockVariants(productId, tx) {
	await tx.$queryRaw`SELECT id FROM product_variants WHERE product_id = ${recordId(productId)}::uuid ORDER BY id FOR UPDATE`;
}

/**
 * For each new option: the index of the stored option it continues (none for a
 * new option), how each stored value is now labelled (a value keeps its label
 * unless renamed; a removed value maps to nothing), and its first value.
 */
function optionMapping(storedOptions, options) {
	const oldIndexByName = new Map(storedOptions.map((option, index) => [option.name, index]));
	return options.map((option) => {
		const oldIndex = oldIndexByName.get(option.previousName ?? option.name);
		const old = oldIndex === undefined ? null : storedOptions[oldIndex];
		const values = new Map();
		if (old) {
			(option.previousValues || []).forEach((previous, index) => {
				if (previous != null && old.values.includes(previous)) values.set(previous, option.values[index]);
			});
			// A value the form did not trace back keeps its label, unless a rename already took it.
			const taken = new Set(values.values());
			for (const value of option.values) {
				if (old.values.includes(value) && !values.has(value) && !taken.has(value)) values.set(value, value);
			}
		}
		return { oldIndex: old ? oldIndex : undefined, values, first: option.values[0] };
	});
}

/** A stored variant's combination under the new options, or null when one of its values is gone. */
function remap(optionValues, mapping) {
	const next = [];
	for (const { oldIndex, values, first } of mapping) {
		if (oldIndex === undefined) {
			next.push(first);
			continue;
		}
		const mapped = values.get(optionValues[oldIndex]);
		if (mapped === undefined) return null;
		next.push(mapped);
	}
	return next;
}

/**
 * Replace the options and variants of `productId` with `setup`, inside `tx`.
 * Call `lockVariants` first (before writing the product row).
 *
 * @param {string} productId
 * @param {{options: Array<{name: string, values: string[], previousName?: string, previousValues?: Array<string|null>}>,
 *          variants: Array<{optionValues: string[], price?: number|null, sku?: string|null, imageUrl?: string|null,
 *                           isActive?: boolean, openingStock?: number}>}} setup
 * @param {object} tx
 * @param {{creating?: boolean}} [mode] `creating`: the product was made in this transaction, so
 *        each variant's `openingStock` becomes its stock (and the product's the sum)
 * @returns {Promise<{openings: Array<{variantId: string, quantity: number}>, archived: number, deleted: number}>}
 * @throws {RecordValidationError} a combination that clashes with an archived one, a variant image
 *         that is not one of the product's, a SKU another product uses
 * @throws {DuplicateKeyError} a SKU another variant uses
 */
function saveVariantSetup(productId, setup, tx, { creating = false } = {}) {
	return translating(async () => {
		const id = recordId(productId);
		const product = await tx.product.findUnique({ where: { id }, select: { images: true } });
		if (!product) throw new RecordValidationError([{ field: 'productId', message: 'Không tìm thấy sản phẩm' }]);
		const storedOptions = await tx.productOption.findMany({ where: { productId: id }, orderBy: { position: 'asc' } });
		const stored = await tx.productVariant.findMany({ where: { productId: id }, orderBy: [{ position: 'asc' }, { id: 'asc' }] });

		for (const [index, variant] of setup.variants.entries()) {
			if (variant.imageUrl && !product.images.includes(variant.imageUrl)) {
				throw new RecordValidationError([{ field: `variants.${index}.imageUrl`, message: 'Ảnh của tổ hợp phải là một ảnh của sản phẩm' }]);
			}
		}
		const skus = setup.variants.map((variant) => variant.sku).filter(Boolean);
		if (skus.length > 0 && (await tx.product.count({ where: { sku: { in: skus } } })) > 0) {
			throw new DuplicateKeyError(['sku']);
		}

		// Which stored variant carries each combination from now on. Every stored
		// variant is mapped through the renames; when two land on one combination the
		// active one wins over an archived one, then the earlier position.
		const mapping = optionMapping(storedOptions, setup.options);
		const carrier = new Map();
		const ranked = [...stored].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.position - b.position);
		for (const variant of ranked) {
			const next = remap(variant.optionValues, mapping);
			if (next && !carrier.has(keyOf(next))) carrier.set(keyOf(next), { variant, next });
		}
		const wanted = new Set(setup.variants.map((variant) => keyOf(variant.optionValues)));
		// An archived variant's labels may no longer be values of any option; offered
		// again under the same labels, it comes back.
		for (const variant of stored) {
			const key = keyOf(variant.optionValues);
			if (variant.archivedAt && wanted.has(key) && !carrier.has(key)) carrier.set(key, { variant, next: variant.optionValues });
		}
		const kept = new Map([...carrier].filter(([key]) => wanted.has(key)));
		const keptIds = new Set([...kept.values()].map(({ variant }) => variant.id));
		const leftovers = stored.filter((variant) => !keptIds.has(variant.id));

		// A leftover is deleted only if nothing ever referenced it and it holds no
		// stock (a balance from before the ledger has no movement); otherwise it is
		// archived and keeps its labels and stock, which still count in the product's.
		// Its labels must not take a combination now offered.
		const leftoverIds = leftovers.map((variant) => variant.id);
		const referenced = new Set(leftovers.filter((variant) => variant.stockQuantity !== 0).map((variant) => variant.id));
		if (leftoverIds.length > 0) {
			const moved = await tx.stockMovement.groupBy({ by: ['variantId'], where: { variantId: { in: leftoverIds } } });
			const sold = await tx.orderItem.groupBy({ by: ['variantId'], where: { variantId: { in: leftoverIds } } });
			for (const row of [...moved, ...sold]) referenced.add(row.variantId);
		}
		const toDelete = leftovers.filter((variant) => !referenced.has(variant.id));
		const toArchive = leftovers.filter((variant) => referenced.has(variant.id));
		for (const variant of toArchive) {
			if (wanted.has(keyOf(variant.optionValues))) {
				throw new RecordValidationError([{ field: 'options', message: `Tổ hợp "${variant.optionValues.join(' / ')}" trùng với một phân loại đã lưu trữ; đổi tên hoặc thứ tự giá trị khác` }]);
			}
		}

		// Unreferenced leftovers go first, freeing their combinations. Kept variants
		// then move to their new labels in two steps, first through a value no
		// combination can have (longer than OPTION_TEXT_MAX in @sab/shared), then to
		// the final label below, so two of them swapping labels never meet the unique
		// index on (product, option_values).
		if (toDelete.length > 0) await tx.productVariant.deleteMany({ where: { id: { in: toDelete.map((variant) => variant.id) } } });
		// SKUs are let go the same way, so two variants can swap theirs; an archived
		// variant gives its SKU up for good.
		for (const { variant } of kept.values()) {
			await tx.productVariant.update({ where: { id: variant.id }, data: { optionValues: [`__moving__${variant.id}`], sku: null } });
		}
		for (const variant of toArchive) {
			if (variant.archivedAt === null) {
				await tx.productVariant.update({ where: { id: variant.id }, data: { isActive: false, archivedAt: new Date(), sku: null } });
			}
		}

		const openings = [];
		let openingTotal = 0;
		for (const [position, wantedVariant] of setup.variants.entries()) {
			const fields = {
				position,
				optionValues: wantedVariant.optionValues,
				price: wantedVariant.price ?? null,
				sku: wantedVariant.sku ?? null,
				imageUrl: wantedVariant.imageUrl ?? null,
				isActive: wantedVariant.isActive !== false,
				archivedAt: null
			};
			const opening = creating ? wantedVariant.openingStock ?? 0 : 0;
			const carried = kept.get(keyOf(wantedVariant.optionValues));
			const row = carried
				? await tx.productVariant.update({ where: { id: carried.variant.id }, data: fields })
				: await tx.productVariant.create({ data: { ...fields, productId: id } });
			if (opening !== 0) {
				await tx.productVariant.update({ where: { id: row.id }, data: { stockQuantity: { increment: opening } } });
				openings.push({ variantId: row.id, quantity: opening });
				openingTotal += opening;
			}
		}
		// Only a product created in this transaction gets here with openings: its stock
		// is the sum of its variants' opening balances.
		if (openingTotal !== 0) await tx.product.update({ where: { id }, data: { stockQuantity: { increment: openingTotal } } });

		await tx.productOption.deleteMany({ where: { productId: id } });
		await tx.productOption.createMany({
			data: setup.options.map((option, position) => ({ productId: id, position, name: option.name, values: option.values }))
		});
		return { openings, archived: toArchive.length, deleted: toDelete.length };
	});
}

/**
 * Whether an uploaded image is still used by any product or variant, so the
 * caller may delete the object only when nothing shows it.
 *
 * @param {string} url
 * @param {object} client the Prisma client or a transaction
 * @returns {Promise<boolean>}
 */
async function isImageInUse(url, client) {
	const [{ used }] = await client.$queryRaw`
		SELECT EXISTS (SELECT 1 FROM products WHERE ${url} = ANY(images) OR image_url = ${url})
			OR EXISTS (SELECT 1 FROM product_variants WHERE image_url = ${url}) AS used`;
	return used;
}

module.exports = { lockVariants, saveVariantSetup, isImageInUse };
