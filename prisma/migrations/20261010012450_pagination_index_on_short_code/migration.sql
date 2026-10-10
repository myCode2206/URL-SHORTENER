-- DropIndex
DROP INDEX "urls_user_id_created_at_id_idx";

-- CreateIndex
CREATE INDEX "urls_user_id_created_at_short_code_idx" ON "urls"("user_id", "created_at" DESC, "short_code" DESC);
