-- G3 durable MOSS chunk identity, callback replay protection and transcript provenance.
ALTER TABLE "MediaObject"
  ADD COLUMN "purgedAt" TIMESTAMP(3);

ALTER TABLE "ProcessingChunk"
  ADD COLUMN "idempotencyKey" VARCHAR(512),
  ADD COLUMN "modelVersion" VARCHAR(128),
  ADD COLUMN "inputVersionId" VARCHAR(512),
  ADD COLUMN "resultVersionId" VARCHAR(512),
  ADD COLUMN "resultChecksum" CHAR(64),
  ADD COLUMN "wordCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "errorDetail" JSONB,
  ADD COLUMN "leaseOwner" VARCHAR(255),
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "nextPollAt" TIMESTAMP(3),
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "externalUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "externalCancelledAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "failedAt" TIMESTAMP(3);

-- G1/G2 never produced chunks. These defaults make the migration explicit and
-- allow a development database with manually-created rows to migrate safely.
UPDATE "ProcessingChunk"
SET "idempotencyKey" = 'legacy:' || "id"::text,
    "modelVersion" = 'legacy-unknown'
WHERE "idempotencyKey" IS NULL OR "modelVersion" IS NULL;

ALTER TABLE "ProcessingChunk"
  ALTER COLUMN "idempotencyKey" SET NOT NULL,
  ALTER COLUMN "modelVersion" SET NOT NULL;

ALTER TABLE "TranscriptVersion"
  ADD COLUMN "processingRunId" UUID,
  ADD COLUMN "pipelineVersion" VARCHAR(128),
  ADD COLUMN "modelVersion" VARCHAR(128);

-- No transcript is published before G3. Abort instead of inventing provenance
-- if a hand-written legacy row exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "TranscriptVersion") THEN
    RAISE EXCEPTION 'G3 migration requires an empty pre-G3 TranscriptVersion table';
  END IF;
END $$;

ALTER TABLE "TranscriptVersion"
  ALTER COLUMN "processingRunId" SET NOT NULL,
  ALTER COLUMN "pipelineVersion" SET NOT NULL,
  ALTER COLUMN "modelVersion" SET NOT NULL;

CREATE TABLE "MossCallbackReceipt" (
  "eventId" VARCHAR(255) NOT NULL,
  "nonce" VARCHAR(255) NOT NULL,
  "processingChunkId" UUID,
  "externalJobId" VARCHAR(512) NOT NULL,
  "idempotencyKey" VARCHAR(512) NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "externalStatus" VARCHAR(64) NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "MossCallbackReceipt_pkey" PRIMARY KEY ("eventId")
);

CREATE UNIQUE INDEX "ProcessingRun_mediaAssetId_pipelineVersion_key"
  ON "ProcessingRun"("mediaAssetId", "pipelineVersion");
CREATE UNIQUE INDEX "ProcessingRun_id_mediaAssetId_key"
  ON "ProcessingRun"("id", "mediaAssetId");
CREATE UNIQUE INDEX "ProcessingChunk_idempotencyKey_key"
  ON "ProcessingChunk"("idempotencyKey");
CREATE UNIQUE INDEX "ProcessingChunk_externalJobId_key"
  ON "ProcessingChunk"("externalJobId");
CREATE INDEX "ProcessingChunk_status_nextPollAt_idx"
  ON "ProcessingChunk"("status", "nextPollAt");
CREATE UNIQUE INDEX "TranscriptVersion_processingRunId_key"
  ON "TranscriptVersion"("processingRunId");
CREATE UNIQUE INDEX "MossCallbackReceipt_nonce_key"
  ON "MossCallbackReceipt"("nonce");
CREATE INDEX "MossCallbackReceipt_externalJobId_receivedAt_idx"
  ON "MossCallbackReceipt"("externalJobId", "receivedAt");
CREATE INDEX "MossCallbackReceipt_processingChunkId_receivedAt_idx"
  ON "MossCallbackReceipt"("processingChunkId", "receivedAt");

ALTER TABLE "ProcessingChunk"
  ADD CONSTRAINT "ProcessingChunk_g3_values_check"
  CHECK ("wordCount" >= 0 AND ("resultChecksum" IS NULL OR "resultChecksum" ~ '^[a-f0-9]{64}$'));

ALTER TABLE "MossCallbackReceipt"
  ADD CONSTRAINT "MossCallbackReceipt_processingChunkId_fkey"
  FOREIGN KEY ("processingChunkId") REFERENCES "ProcessingChunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TranscriptVersion"
  ADD CONSTRAINT "TranscriptVersion_processingRunId_fkey"
  FOREIGN KEY ("processingRunId", "mediaAssetId") REFERENCES "ProcessingRun"("id", "mediaAssetId") ON DELETE RESTRICT ON UPDATE CASCADE;
