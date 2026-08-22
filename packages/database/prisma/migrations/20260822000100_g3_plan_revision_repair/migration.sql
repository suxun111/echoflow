-- G3 bounded immutable replan: a repair creates a revision overlay instead of
-- overwriting the original chunk identity or reusing its external MOSS job.
ALTER TABLE "ProcessingRun"
  ADD COLUMN "activePlanRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pendingPlanRevision" INTEGER,
  ADD COLUMN "repairPlan" JSONB;

ALTER TABLE "ProcessingChunk"
  ADD COLUMN "planRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inputChecksum" CHAR(64);

ALTER TABLE "TranscriptVersion"
  ADD COLUMN "planRevision" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "ProcessingChunk_processingRunId_chunkIndex_key";

CREATE UNIQUE INDEX "ProcessingChunk_processingRunId_planRevision_chunkIndex_key"
  ON "ProcessingChunk"("processingRunId", "planRevision", "chunkIndex");
CREATE INDEX "ProcessingChunk_processingRunId_chunkIndex_planRevision_idx"
  ON "ProcessingChunk"("processingRunId", "chunkIndex", "planRevision");

ALTER TABLE "ProcessingRun"
  ADD CONSTRAINT "ProcessingRun_plan_revision_check"
  CHECK (
    "activePlanRevision" BETWEEN 0 AND 1
    AND (
      "pendingPlanRevision" IS NULL
      OR (
        "pendingPlanRevision" BETWEEN 0 AND 1
        AND "pendingPlanRevision" = "activePlanRevision" + 1
      )
    )
  );

ALTER TABLE "ProcessingChunk"
  ADD CONSTRAINT "ProcessingChunk_plan_identity_check"
  CHECK (
    "planRevision" BETWEEN 0 AND 1
    AND ("inputChecksum" IS NULL OR "inputChecksum" ~ '^[a-f0-9]{64}$')
    AND (
      "planRevision" = 0
      OR ("inputVersionId" IS NOT NULL AND "inputChecksum" IS NOT NULL)
    )
  );

ALTER TABLE "TranscriptVersion"
  ADD CONSTRAINT "TranscriptVersion_plan_revision_check"
  CHECK ("planRevision" BETWEEN 0 AND 1);

CREATE FUNCTION "prevent_processing_chunk_identity_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."planRevision" IS DISTINCT FROM NEW."planRevision"
    OR OLD."processingRunId" IS DISTINCT FROM NEW."processingRunId"
    OR OLD."chunkIndex" IS DISTINCT FROM NEW."chunkIndex"
    OR OLD."startMs" IS DISTINCT FROM NEW."startMs"
    OR OLD."endMs" IS DISTINCT FROM NEW."endMs"
    OR OLD."inputObjectKey" IS DISTINCT FROM NEW."inputObjectKey"
    OR OLD."inputVersionId" IS DISTINCT FROM NEW."inputVersionId"
    OR OLD."inputChecksum" IS DISTINCT FROM NEW."inputChecksum"
    OR OLD."modelVersion" IS DISTINCT FROM NEW."modelVersion"
    OR OLD."idempotencyKey" IS DISTINCT FROM NEW."idempotencyKey"
    OR (OLD."resultObjectKey" IS NOT NULL AND NEW."resultObjectKey" IS DISTINCT FROM OLD."resultObjectKey")
    OR (OLD."resultVersionId" IS NOT NULL AND NEW."resultVersionId" IS DISTINCT FROM OLD."resultVersionId")
    OR (OLD."resultChecksum" IS NOT NULL AND NEW."resultChecksum" IS DISTINCT FROM OLD."resultChecksum")
  THEN
    RAISE EXCEPTION 'ProcessingChunk immutable identity fields cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProcessingChunk_prevent_identity_mutation"
BEFORE UPDATE ON "ProcessingChunk"
FOR EACH ROW EXECUTE FUNCTION "prevent_processing_chunk_identity_mutation"();
