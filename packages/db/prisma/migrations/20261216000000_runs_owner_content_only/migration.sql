-- The column was added by editing an already-applied migration, so databases that had applied it never got it.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ownerContentOnly" BOOLEAN NOT NULL DEFAULT false;
