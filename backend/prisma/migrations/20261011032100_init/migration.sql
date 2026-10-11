-- CreateEnum
CREATE TYPE "sales_channel" AS ENUM ('all', 'online', 'offline');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('confirmed', 'paid', 'delivered', 'cancelled');

-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('opening', 'order', 'order_cancel', 'order_edit', 'adjust', 'set_target');

-- CreateEnum
CREATE TYPE "movement_status" AS ENUM ('pending', 'applied');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "username" TEXT NOT NULL,
    "displayUsername" TEXT,
    "role" TEXT DEFAULT 'user',
    "banned" BOOLEAN DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMPTZ(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "impersonatedBy" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jwks" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "alg" TEXT,
    "crv" TEXT,

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "image_url" TEXT NOT NULL DEFAULT '/fallback-product.png',
    "category" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sales_channel" "sales_channel" NOT NULL DEFAULT 'all',
    "stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "min_order_quantity" INTEGER NOT NULL DEFAULT 1,
    "max_order_quantity" INTEGER,
    "sku" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "weight" DOUBLE PRECISION,
    "dimension_length" DOUBLE PRECISION,
    "dimension_width" DOUBLE PRECISION,
    "dimension_height" DOUBLE PRECISION,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sale_price" INTEGER,
    "sale_start_date" TIMESTAMPTZ(3),
    "sale_end_date" TIMESTAMPTZ(3),
    "public_code" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combos" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sales_channel" "sales_channel" NOT NULL DEFAULT 'all',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "public_code" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "combos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_category_requirements" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "combo_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "combo_category_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "order_code" VARCHAR(10) NOT NULL,
    "order_number" TEXT,
    "phone_number" TEXT,
    "student_id" TEXT,
    "full_name" TEXT,
    "email" TEXT,
    "additional_note" TEXT,
    "total_amount" INTEGER NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'confirmed',
    "stock_deducted" BOOLEAN NOT NULL DEFAULT false,
    "transaction_code" TEXT,
    "cancel_reason" TEXT,
    "items_revision" INTEGER NOT NULL DEFAULT 0,
    "last_updated_by" TEXT NOT NULL DEFAULT 'system',
    "status_updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_direct_sale" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "combo_info" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "order_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "from_combo" BOOLEAN NOT NULL DEFAULT false,
    "combo_id" TEXT,
    "combo_name" TEXT,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "order_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "order_status" NOT NULL,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transaction_code" TEXT,
    "cancel_reason" TEXT,
    "note" TEXT,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_internal_notes" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "order_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items_edits" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "order_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "previous_items" JSONB NOT NULL,
    "previous_combo_info" JSONB,
    "edited_by" TEXT NOT NULL,
    "edited_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "order_items_edits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "product_id" TEXT NOT NULL,
    "type" "movement_type" NOT NULL,
    "delta" INTEGER,
    "target" INTEGER,
    "order_id" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT NOT NULL DEFAULT '',
    "idempotency_key" TEXT NOT NULL,
    "status" "movement_status" NOT NULL DEFAULT 'pending',
    "applied_at" TIMESTAMPTZ(3),
    "stock_after" INTEGER,
    "claimed_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" SERIAL NOT NULL,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL DEFAULT substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24),
    "key" TEXT NOT NULL DEFAULT 'payment_config',
    "bank_name_id" TEXT NOT NULL,
    "bank_account_id" TEXT NOT NULL,
    "prefix_message" TEXT NOT NULL DEFAULT 'SAB',
    "store_title" TEXT,
    "checkout_notice" TEXT,
    "event_notice" TEXT,
    "payment_notice" TEXT,
    "contact_email" TEXT,
    "contact_facebook_url" TEXT,
    "updated_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_public_code_key" ON "products"("public_code");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE INDEX "products_available_idx" ON "products"("available");

-- CreateIndex
CREATE INDEX "products_sales_channel_idx" ON "products"("sales_channel");

-- CreateIndex
CREATE INDEX "products_featured_idx" ON "products"("featured");

-- CreateIndex
CREATE INDEX "products_created_at_idx" ON "products"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "combos_public_code_key" ON "combos"("public_code");

-- CreateIndex
CREATE INDEX "combos_is_active_priority_created_at_idx" ON "combos"("is_active", "priority" DESC, "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "combo_category_requirements_combo_id_position_key" ON "combo_category_requirements"("combo_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_code_key" ON "orders"("order_code");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_student_id_idx" ON "orders"("student_id");

-- CreateIndex
CREATE INDEX "orders_email_idx" ON "orders"("email");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_is_direct_sale_idx" ON "orders"("is_direct_sale");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_position_key" ON "order_items"("order_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "order_status_history_order_id_position_key" ON "order_status_history"("order_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "order_internal_notes_order_id_position_key" ON "order_internal_notes"("order_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_edits_order_id_position_key" ON "order_items_edits"("order_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_idempotency_key_key" ON "stock_movements"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_seq_key" ON "stock_movements"("seq");

-- CreateIndex
CREATE INDEX "stock_movements_product_id_status_seq_idx" ON "stock_movements"("product_id", "status", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_category_requirements" ADD CONSTRAINT "combo_category_requirements_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_internal_notes" ADD CONSTRAINT "order_internal_notes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items_edits" ADD CONSTRAINT "order_items_edits_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Constraints and indexes Prisma cannot express. Everything below is hand-written
-- and kept at the end so regenerating the table DDL above does not touch it.

-- Rules that replace Mongoose validators and must hold even for a writer that
-- skipped the application layer. Length caps, trimming and casing stay in Zod and
-- the repositories.
ALTER TABLE "products" ADD CONSTRAINT "products_min_order_quantity_check" CHECK ("min_order_quantity" >= 1);
ALTER TABLE "products" ADD CONSTRAINT "products_weight_check" CHECK ("weight" IS NULL OR "weight" >= 0);
ALTER TABLE "combo_category_requirements" ADD CONSTRAINT "combo_category_requirements_quantity_check" CHECK ("quantity" >= 1);
ALTER TABLE "orders" ADD CONSTRAINT "orders_phone_number_check" CHECK ("phone_number" IS NULL OR "phone_number" ~ '^0[0-9]{9}$');
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_check" CHECK ("quantity" >= 1);

-- A set_target movement carries its target and no delta until the ledger worker
-- applies it (the delta depends on the stock at that moment); every other type
-- carries a delta and no target.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_set_target_shape_check" CHECK (
  ("type" = 'set_target' AND "target" IS NOT NULL AND ("status" = 'applied' OR "delta" IS NULL))
  OR ("type" <> 'set_target' AND "target" IS NULL AND "delta" IS NOT NULL)
);

-- The sweeper scans pending movements across all products by age. Almost every
-- movement is applied, so the partial filter keeps this index tiny.
CREATE INDEX "pending_by_age" ON "stock_movements" ("seq") WHERE "status" = 'pending';

-- Money fails closed: no negative price or total, whatever wrote the row.
ALTER TABLE "products" ADD CONSTRAINT "products_price_check" CHECK ("price" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_sale_price_check" CHECK ("sale_price" IS NULL OR "sale_price" >= 0);
ALTER TABLE "combos" ADD CONSTRAINT "combos_price_check" CHECK ("price" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_amount_check" CHECK ("total_amount" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_check" CHECK ("price" >= 0);

-- Prisma emits scalar lists nullable; a product always has a (possibly empty) tag list.
ALTER TABLE "products" ALTER COLUMN "tags" SET NOT NULL;
