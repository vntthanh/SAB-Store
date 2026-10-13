-- CreateTable
CREATE TABLE "mail_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'smtp',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT NOT NULL,
    "pass_encrypted" TEXT NOT NULL,
    "from_name" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "notify_order_created" BOOLEAN NOT NULL DEFAULT true,
    "notify_status_changed" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_settings_key_key" ON "mail_settings"("key");

