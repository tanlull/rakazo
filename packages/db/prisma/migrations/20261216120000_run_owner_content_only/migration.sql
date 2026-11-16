-- Unknown runs count as having read outside content.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ownerContentOnly" BOOLEAN NOT NULL DEFAULT false;
