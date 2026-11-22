ALTER TABLE "escrow_events" DROP CONSTRAINT "escrow_events_intent_hash_intents_intent_hash_fk";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "escrow_events_intent_hash_idx" ON "escrow_events" USING btree ("intent_hash");