-- Statement order is the invariant: the new columns stay nullable until the
-- backfill has stamped every row, and only then is NOT NULL applied.

-- CreateEnum
CREATE TYPE "storefront_visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "storefront_rule_type" AS ENUM ('EMAIL', 'DOMAIN', 'LIST');

-- CreateTable
CREATE TABLE "storefronts" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500),
    "visibility" "storefront_visibility" NOT NULL DEFAULT 'PUBLIC',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefronts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_access_rules" (
    "id" UUID NOT NULL,
    "storefront_id" UUID NOT NULL,
    "type" "storefront_rule_type" NOT NULL,
    "value" VARCHAR(254),
    "email_list_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storefront_access_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_lists" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_list_entries" (
    "id" UUID NOT NULL,
    "email_list_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_storefronts" (
    "id" UUID NOT NULL,
    "combo_id" UUID NOT NULL,
    "storefront_id" UUID NOT NULL,

    CONSTRAINT "combo_storefronts_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "products" ADD COLUMN "storefront_id" UUID;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "storefront_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "storefronts_slug_key" ON "storefronts"("slug");

-- CreateIndex
CREATE INDEX "storefronts_is_active_sort_order_id_idx" ON "storefronts"("is_active", "sort_order", "id");

-- CreateIndex
CREATE INDEX "storefront_access_rules_storefront_id_idx" ON "storefront_access_rules"("storefront_id");

-- CreateIndex
CREATE INDEX "storefront_access_rules_email_list_id_idx" ON "storefront_access_rules"("email_list_id");

-- CreateIndex
CREATE UNIQUE INDEX "storefront_access_rules_storefront_id_type_value_key" ON "storefront_access_rules"("storefront_id", "type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "email_lists_name_key" ON "email_lists"("name");

-- CreateIndex
CREATE INDEX "email_list_entries_email_idx" ON "email_list_entries"("email");

-- CreateIndex
CREATE UNIQUE INDEX "email_list_entries_email_list_id_email_key" ON "email_list_entries"("email_list_id", "email");

-- CreateIndex
CREATE INDEX "combo_storefronts_storefront_id_idx" ON "combo_storefronts"("storefront_id");

-- CreateIndex
CREATE UNIQUE INDEX "combo_storefronts_combo_id_storefront_id_key" ON "combo_storefronts"("combo_id", "storefront_id");

-- CreateIndex
CREATE INDEX "products_storefront_id_idx" ON "products"("storefront_id");

-- CreateIndex
CREATE INDEX "orders_storefront_id_idx" ON "orders"("storefront_id");

-- AddForeignKey
ALTER TABLE "storefront_access_rules" ADD CONSTRAINT "storefront_access_rules_storefront_id_fkey" FOREIGN KEY ("storefront_id") REFERENCES "storefronts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_access_rules" ADD CONSTRAINT "storefront_access_rules_email_list_id_fkey" FOREIGN KEY ("email_list_id") REFERENCES "email_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_list_entries" ADD CONSTRAINT "email_list_entries_email_list_id_fkey" FOREIGN KEY ("email_list_id") REFERENCES "email_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_storefronts" ADD CONSTRAINT "combo_storefronts_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_storefronts" ADD CONSTRAINT "combo_storefronts_storefront_id_fkey" FOREIGN KEY ("storefront_id") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_storefront_id_fkey" FOREIGN KEY ("storefront_id") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_storefront_id_fkey" FOREIGN KEY ("storefront_id") REFERENCES "storefronts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules Prisma cannot express.
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- A LIST rule points at a list and carries no value; EMAIL and DOMAIN carry a
-- lowercase value and no list.
ALTER TABLE "storefront_access_rules" ADD CONSTRAINT "storefront_access_rules_list_ref_check" CHECK (("type" = 'LIST') = ("email_list_id" IS NOT NULL));
ALTER TABLE "storefront_access_rules" ADD CONSTRAINT "storefront_access_rules_list_value_check" CHECK (("type" = 'LIST') = ("value" IS NULL));
ALTER TABLE "storefront_access_rules" ADD CONSTRAINT "storefront_access_rules_value_lower_check" CHECK ("value" = lower("value"));
ALTER TABLE "email_list_entries" ADD CONSTRAINT "email_list_entries_email_lower_check" CHECK ("email" = lower("email"));

-- The (storefront_id, type, value) unique cannot catch a repeated LIST rule
-- because its value is NULL.
CREATE UNIQUE INDEX "storefront_access_rules_list_key" ON "storefront_access_rules"("storefront_id", "email_list_id") WHERE "type" = 'LIST';

-- The default storefront. Its id is a fixed constant shared with
-- backend/data/default-storefront.js (a test keeps the two equal). PG17 has no
-- uuidv7(), so the constant was generated once with the uuid package.
INSERT INTO "storefronts" ("id", "slug", "name", "visibility", "sort_order")
VALUES ('01a173f3-7280-71fd-b24f-118da6196e35', 'cua-hang', 'Cửa hàng', 'PUBLIC', 0);

-- Every existing product, and every online order, belongs to it. Direct (counter)
-- sales stay without a storefront.
UPDATE "products" SET "storefront_id" = '01a173f3-7280-71fd-b24f-118da6196e35' WHERE "storefront_id" IS NULL;
UPDATE "orders" SET "storefront_id" = '01a173f3-7280-71fd-b24f-118da6196e35' WHERE "is_direct_sale" = false AND "storefront_id" IS NULL;
ALTER TABLE "products" ALTER COLUMN "storefront_id" SET NOT NULL;

-- UUIDv7 for the link rows: 48-bit millisecond clock, version nibble 7, the
-- variant bits of gen_random_uuid(), random bytes for the rest. Session-scoped,
-- so nothing is left in the schema (the drop below is only tidiness).
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

INSERT INTO "combo_storefronts" ("id", "combo_id", "storefront_id")
SELECT pg_temp.uuid_v7(), "id", '01a173f3-7280-71fd-b24f-118da6196e35' FROM "combos";

DROP FUNCTION pg_temp.uuid_v7();
