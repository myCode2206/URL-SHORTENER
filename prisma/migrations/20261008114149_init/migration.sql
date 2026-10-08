-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "urls" (
    "id" BIGSERIAL NOT NULL,
    "short_code" VARCHAR(16) NOT NULL,
    "custom_alias" VARCHAR(64),
    "original_url" TEXT NOT NULL,
    "user_id" UUID,
    "expires_at" TIMESTAMPTZ(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "click_count" BIGINT NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "urls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clicks" (
    "id" BIGSERIAL NOT NULL,
    "url_id" BIGINT NOT NULL,
    "clicked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "referrer" VARCHAR(2048),
    "country" CHAR(2),
    "device" VARCHAR(16),
    "browser" VARCHAR(64),
    "os" VARCHAR(64),

    CONSTRAINT "clicks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "urls_short_code_key" ON "urls"("short_code");

-- CreateIndex
CREATE UNIQUE INDEX "urls_custom_alias_key" ON "urls"("custom_alias");

-- CreateIndex
CREATE INDEX "urls_user_id_created_at_id_idx" ON "urls"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "clicks_url_id_clicked_at_idx" ON "clicks"("url_id", "clicked_at");

-- AddForeignKey
ALTER TABLE "urls" ADD CONSTRAINT "urls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_url_id_fkey" FOREIGN KEY ("url_id") REFERENCES "urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
