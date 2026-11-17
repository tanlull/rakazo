-- Older prompts and every bot-written prompt start as not the owner's.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "promptByOwner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ownerRoutinePrompt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ownerContentOnly" BOOLEAN NOT NULL DEFAULT false;
