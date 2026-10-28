-- Product images, options and variants. Every existing product gets one default
-- variant (no option values) holding its stock, and every order line and stock
-- movement of that product is pointed at it. Statement order is the invariant:
-- new columns stay nullable until the backfill has stamped every row.
--
-- One-way: a release before this one cannot insert a movement (variant_id is
-- NOT NULL) and would move only the product's stock. Coolify removes the whole
-- stack before the release job runs this, so no such release is running; going
-- back to one means restoring an export taken before the deploy.

-- Defence in depth: nothing may apply a movement while the stock is copied.
LOCK TABLE "products", "stock_movements" IN SHARE ROW EXCLUSIVE MODE;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "variant_id" UUID,
ADD COLUMN     "variant_label" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "variant_id" UUID;

-- CreateTable
CREATE TABLE "product_options" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" VARCHAR(30) NOT NULL,
    "values" TEXT[],

    CONSTRAINT "product_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "option_values" TEXT[],
    "price" INTEGER,
    "sku" TEXT,
    "image_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(3),
    "stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_options_product_id_position_key" ON "product_options"("product_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "product_options_product_id_name_key" ON "product_options"("product_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");

-- CreateIndex
CREATE INDEX "product_variants_product_id_position_idx" ON "product_variants"("product_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_product_id_option_values_key" ON "product_variants"("product_id", "option_values");

-- CreateIndex
CREATE INDEX "stock_movements_variant_id_status_idx" ON "stock_movements"("variant_id", "status");

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- UUIDv7 for the rows made here (same helper as the storefronts migration; PG17
-- has no uuidv7()).
CREATE FUNCTION pg_temp.uuid_v7() RETURNS uuid LANGUAGE sql VOLATILE AS $$
    SELECT encode(
        set_bit(
            set_bit(
                overlay(
                    uuid_send(gen_random_uuid())
                    PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                    FROM 1 FOR 6
                ),
                52, 1
            ),
            53, 1
        ),
        'hex'
    )::uuid
$$;

-- The single image becomes the gallery; an empty URL already rendered as the
-- fallback, so it is stored as one.
UPDATE "products" SET "image_url" = '/fallback-product.png' WHERE "image_url" = '';
UPDATE "products" SET "images" = ARRAY["image_url"] WHERE "image_url" <> '/fallback-product.png';
UPDATE "products" SET "images" = ARRAY[]::TEXT[] WHERE "images" IS NULL;

-- One default variant per product, holding the product's stock cache (which the
-- lock above keeps still).
INSERT INTO "product_variants" ("id", "product_id", "position", "option_values", "stock_quantity", "created_at", "updated_at")
SELECT pg_temp.uuid_v7(), "id", 0, ARRAY[]::TEXT[], "stock_quantity", "created_at", CURRENT_TIMESTAMP FROM "products";

UPDATE "order_items" AS oi SET "variant_id" = v."id"
FROM "product_variants" AS v WHERE v."product_id" = oi."product_id";

UPDATE "stock_movements" AS m SET "variant_id" = v."id"
FROM "product_variants" AS v WHERE v."product_id" = m."product_id";

-- Movements of products deleted earlier have no variant to point at. A fresh id
-- each keeps the column NOT NULL; the ledger settles them as it settles any
-- movement whose product is gone.
UPDATE "stock_movements" SET "variant_id" = pg_temp.uuid_v7() WHERE "variant_id" IS NULL;

DROP FUNCTION pg_temp.uuid_v7();

ALTER TABLE "stock_movements" ALTER COLUMN "variant_id" SET NOT NULL;
ALTER TABLE "products" ALTER COLUMN "images" SET NOT NULL;
ALTER TABLE "product_options" ALTER COLUMN "values" SET NOT NULL;
ALTER TABLE "product_variants" ALTER COLUMN "option_values" SET NOT NULL;

-- Rules Prisma cannot express. The cross-table ones (a variant's values match its
-- product's options, a variant image is one of the product's images, at least one
-- active variant per product) live in data/postgres/products.js.
ALTER TABLE "products" ADD CONSTRAINT "products_images_count_check" CHECK (cardinality("images") <= 9);
ALTER TABLE "products" ADD CONSTRAINT "products_cover_check" CHECK ("image_url" = COALESCE("images"[1], '/fallback-product.png'));
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_values_check" CHECK (cardinality("values") BETWEEN 1 AND 50);
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_position_check" CHECK ("position" >= 0);
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_price_check" CHECK ("price" IS NULL OR "price" >= 0);
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_position_check" CHECK ("position" >= 0);
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_archived_check" CHECK ("archived_at" IS NULL OR "is_active" = false);
