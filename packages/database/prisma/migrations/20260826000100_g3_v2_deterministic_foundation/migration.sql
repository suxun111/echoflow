-- G3 v2 deterministic foundation (Route B handoff evidence layer).
-- Forward-only: adds v2 entities/enum values and v1-safe H_* columns.
-- Does NOT touch historical migrations, v1 rows, or existing object data.
-- Enum values are added but NOT used by any INSERT in this migration
-- (PostgreSQL forbids using a newly added enum value in the same txn).
-- Requires PostgreSQL >= 13 (ALTER TYPE ADD VALUE IF NOT EXISTS needs >= 12;
-- the test harness's DROP DATABASE ... WITH (FORCE) needs >= 13).

-- 1. Extend enums (forward-only; new values unused below).
ALTER TYPE "MediaObjectKind" ADD VALUE IF NOT EXISTS 'HANDOFF_AUDIO';
ALTER TYPE "MediaObjectKind" ADD VALUE IF NOT EXISTS 'ALIGNMENT_RAW';
ALTER TYPE "ProcessingStage" ADD VALUE IF NOT EXISTS 'HANDOFF_EVIDENCING';

-- 2. TranscriptVersion H_* summary columns (v1 rows keep all-zero defaults).
ALTER TABLE "TranscriptVersion"
  ADD COLUMN "hTotal" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hUnique" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hR1" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hUnresolved" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hSegment" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hProviderWord" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hAlignment" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "TranscriptVersion"
  ADD CONSTRAINT "TranscriptVersion_h_counts_check"
  CHECK (
    "hTotal" >= 0 AND "hUnique" >= 0 AND "hR1" >= 0 AND "hUnresolved" >= 0
    AND "hSegment" >= 0 AND "hProviderWord" >= 0 AND "hAlignment" >= 0
    AND "hUnique" + "hR1" + "hUnresolved" = "hTotal"
    AND "hSegment" + "hProviderWord" + "hAlignment" = "hUnique" + "hR1"
    AND "hProviderWord" = 0
  );

-- 3. Composite unique target for ProcessingHandoff -> ProcessingChunk FKs.
CREATE UNIQUE INDEX "ProcessingChunk_id_processingRunId_key"
  ON "ProcessingChunk"("id", "processingRunId");

-- 4. ProcessingHandoff.
CREATE TABLE "ProcessingHandoff" (
  "id" UUID NOT NULL,
  "processingRunId" UUID NOT NULL,
  "planRevision" INTEGER NOT NULL DEFAULT 0,
  "logicalHandoffIndex" INTEGER NOT NULL,
  "previousChunkId" UUID NOT NULL,
  "nextChunkId" UUID NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "errorCode" VARCHAR(128),
  "leaseOwner" VARCHAR(255),
  "leaseExpiresAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProcessingHandoff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcessingHandoff_processingRunId_planRevision_logicalHandoffIndex_key"
  ON "ProcessingHandoff"("processingRunId", "planRevision", "logicalHandoffIndex");
CREATE UNIQUE INDEX "ProcessingHandoff_id_processingRunId_key"
  ON "ProcessingHandoff"("id", "processingRunId");
CREATE INDEX "ProcessingHandoff_processingRunId_status_idx"
  ON "ProcessingHandoff"("processingRunId", "status");
CREATE INDEX "ProcessingHandoff_status_leaseExpiresAt_idx"
  ON "ProcessingHandoff"("status", "leaseExpiresAt");

ALTER TABLE "ProcessingHandoff"
  ADD CONSTRAINT "ProcessingHandoff_processingRunId_fkey"
  FOREIGN KEY ("processingRunId") REFERENCES "ProcessingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProcessingHandoff_previousChunkId_processingRunId_fkey"
  FOREIGN KEY ("previousChunkId", "processingRunId") REFERENCES "ProcessingChunk"("id", "processingRunId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProcessingHandoff_nextChunkId_processingRunId_fkey"
  FOREIGN KEY ("nextChunkId", "processingRunId") REFERENCES "ProcessingChunk"("id", "processingRunId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProcessingHandoff_identity_check"
  CHECK (
    "planRevision" BETWEEN 0 AND 1
    AND "logicalHandoffIndex" >= 0
    AND "attempt" >= 0
    AND "status" IN ('PENDING', 'ASSESSING', 'ALIGNING', 'EVIDENCED', 'FAILED', 'CANCELLED')
    AND "previousChunkId" <> "nextChunkId"
  );

-- 5. HandoffAssessment (immutable, non-terminal strict-segment snapshot).
CREATE TABLE "HandoffAssessment" (
  "id" UUID NOT NULL,
  "handoffId" UUID NOT NULL,
  "decision" VARCHAR(32) NOT NULL,
  "decisionCode" VARCHAR(128) NOT NULL,
  "evidenceType" VARCHAR(64) NOT NULL,
  "inputChecksum" CHAR(64) NOT NULL,
  "windowStartMs" INTEGER NOT NULL,
  "windowEndMs" INTEGER NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HandoffAssessment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HandoffAssessment_handoffId_key" UNIQUE ("handoffId"),
  CONSTRAINT "HandoffAssessment_handoffId_fkey"
    FOREIGN KEY ("handoffId") REFERENCES "ProcessingHandoff"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "HandoffAssessment_result_check"
  CHECK (
    "decision" IN ('accepted', 'insufficient', 'ambiguous')
    AND "evidenceType" = 'strict_segment'
    AND (
      ("decision" = 'accepted' AND "decisionCode" = 'strict_segment_accepted')
      OR (
        "decision" = 'insufficient'
        AND "decisionCode" IN (
          'no_handoff_text', 'single_token_candidate', 'window_out_of_bounds',
          'mixed_granularity', 'missing_fields', 'identity_mismatch', 'result_invalid'
        )
      )
      OR (
        "decision" = 'ambiguous'
        AND "decisionCode" IN (
          'no_textual_suffix_prefix', 'text_match_without_time_overlap',
          'text_time_match_with_speaker_conflict', 'multiple_valid_alignments',
          'weak_single_token_alignment'
        )
      )
    )
    AND "windowEndMs" > "windowStartMs"
    AND "inputChecksum" ~ '^[a-f0-9]{64}$'
  )
);
CREATE INDEX "HandoffAssessment_handoffId_decision_idx"
  ON "HandoffAssessment"("handoffId", "decision");

-- 6. AlignmentJob (route B submission unit; independent of ProcessingChunk).
CREATE TABLE "AlignmentJob" (
  "id" UUID NOT NULL,
  "handoffId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(512) NOT NULL,
  "correlationHandle" VARCHAR(255) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "externalJobId" VARCHAR(512),
  "windowStartMs" INTEGER NOT NULL,
  "windowEndMs" INTEGER NOT NULL,
  "methodDigest" CHAR(64) NOT NULL,
  "modelDigest" CHAR(64) NOT NULL,
  "configDigest" CHAR(64) NOT NULL,
  "errorCode" VARCHAR(128),
  "leaseOwner" VARCHAR(255),
  "leaseExpiresAt" TIMESTAMP(3),
  "nextPollAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "externalUpdatedAt" TIMESTAMP(3),
  "externalCancelledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AlignmentJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AlignmentJob_handoffId_key" UNIQUE ("handoffId"),
  CONSTRAINT "AlignmentJob_idempotencyKey_key" UNIQUE ("idempotencyKey"),
  CONSTRAINT "AlignmentJob_correlationHandle_key" UNIQUE ("correlationHandle"),
  CONSTRAINT "AlignmentJob_externalJobId_key" UNIQUE ("externalJobId"),
  CONSTRAINT "AlignmentJob_handoffId_fkey"
    FOREIGN KEY ("handoffId") REFERENCES "ProcessingHandoff"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AlignmentJob_identity_check"
  CHECK (
    "status" IN ('PENDING', 'SUBMITTED', 'POLLING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
    AND "attempt" BETWEEN 0 AND 3
    AND "windowEndMs" > "windowStartMs"
    AND "methodDigest" ~ '^[a-f0-9]{64}$'
    AND "modelDigest" ~ '^[a-f0-9]{64}$'
    AND "configDigest" ~ '^[a-f0-9]{64}$'
    AND "correlationHandle" <> ''
  )
);
CREATE INDEX "AlignmentJob_status_nextPollAt_idx"
  ON "AlignmentJob"("status", "nextPollAt");
CREATE INDEX "AlignmentJob_status_nextAttemptAt_idx"
  ON "AlignmentJob"("status", "nextAttemptAt");

-- 7. HandoffEvidence (unique final decision per handoff; terminal and immutable).
CREATE TABLE "HandoffEvidence" (
  "id" UUID NOT NULL,
  "handoffId" UUID NOT NULL,
  "planRevision" INTEGER NOT NULL,
  "logicalHandoffIndex" INTEGER NOT NULL,
  "decision" VARCHAR(32) NOT NULL,
  "decisionCode" VARCHAR(128) NOT NULL,
  "evidenceType" VARCHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "pipelineVersion" VARCHAR(128) NOT NULL,
  "previousChunkId" UUID NOT NULL,
  "nextChunkId" UUID NOT NULL,
  "normalizedAudioVersionId" VARCHAR(512),
  "normalizedAudioChecksum" CHAR(64),
  "previousAsrObjectKey" VARCHAR(1024) NOT NULL,
  "previousAsrVersionId" VARCHAR(512),
  "previousAsrChecksum" CHAR(64),
  "nextAsrObjectKey" VARCHAR(1024) NOT NULL,
  "nextAsrVersionId" VARCHAR(512),
  "nextAsrChecksum" CHAR(64),
  "rawObjectKey" VARCHAR(1024),
  "rawVersionId" VARCHAR(512),
  "rawChecksum" CHAR(64),
  "methodProvider" VARCHAR(128) NOT NULL,
  "methodVersion" VARCHAR(128) NOT NULL,
  "modelRevision" VARCHAR(128),
  "alignmentPolicyDigest" CHAR(64),
  "windowStartMs" INTEGER NOT NULL,
  "windowEndMs" INTEGER NOT NULL,
  "candidateCount" INTEGER NOT NULL DEFAULT 0,
  "anchorCount" INTEGER NOT NULL DEFAULT 0,
  "coverageMs" INTEGER NOT NULL DEFAULT 0,
  "proofKeyVersion" VARCHAR(64) NOT NULL,
  "proofDigest" CHAR(64) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HandoffEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HandoffEvidence_handoffId_key" UNIQUE ("handoffId"),
  CONSTRAINT "HandoffEvidence_id_handoffId_key" UNIQUE ("id", "handoffId"),
  CONSTRAINT "HandoffEvidence_handoffId_fkey"
    FOREIGN KEY ("handoffId") REFERENCES "ProcessingHandoff"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "HandoffEvidence_result_check"
  CHECK (
    "decision" IN ('accepted', 'insufficient', 'ambiguous')
    AND "evidenceType" IN ('strict_segment', 'boundary_forced_alignment')
    AND "planRevision" BETWEEN 0 AND 1
    AND "logicalHandoffIndex" >= 0
    AND "windowEndMs" > "windowStartMs"
    AND "proofKeyVersion" <> ''
    AND "proofDigest" ~ '^[a-f0-9]{64}$'
    AND ("normalizedAudioChecksum" IS NULL OR "normalizedAudioChecksum" ~ '^[a-f0-9]{64}$')
    AND ("previousAsrChecksum" IS NULL OR "previousAsrChecksum" ~ '^[a-f0-9]{64}$')
    AND ("nextAsrChecksum" IS NULL OR "nextAsrChecksum" ~ '^[a-f0-9]{64}$')
    AND ("rawChecksum" IS NULL OR "rawChecksum" ~ '^[a-f0-9]{64}$')
    AND ("rawChecksum" IS NOT NULL OR "rawObjectKey" IS NULL)
    AND ("rawVersionId" IS NOT NULL OR "rawObjectKey" IS NULL)
    AND ("rawObjectKey" IS NULL OR ("rawVersionId" IS NOT NULL AND "rawChecksum" IS NOT NULL))
    AND (
      NOT ("decision" = 'accepted' AND "evidenceType" = 'boundary_forced_alignment')
      OR (
        "rawObjectKey" IS NOT NULL
        AND "rawVersionId" IS NOT NULL
        AND "rawChecksum" IS NOT NULL
        AND "anchorCount" >= 2
        AND "candidateCount" >= 1
      )
    )
    AND (
      NOT ("decision" = 'accepted' AND "evidenceType" = 'strict_segment')
      OR "candidateCount" = 1
    )
    AND (
      ("decision" = 'accepted' AND "decisionCode" = 'evidence_accepted')
      OR (
        "decision" = 'insufficient'
        AND "decisionCode" IN (
          'alignment_unavailable', 'alignment_timeout', 'alignment_rate_limited',
          'alignment_input_mismatch', 'alignment_result_invalid', 'alignment_cancelled'
        )
      )
      OR (
        "decision" = 'ambiguous'
        AND "decisionCode" IN (
          'no_textual_suffix_prefix', 'text_match_without_time_overlap',
          'text_time_match_with_speaker_conflict', 'multiple_valid_alignments',
          'weak_single_token_alignment'
        )
      )
    )
  )
);
CREATE INDEX "HandoffEvidence_handoffId_planRevision_idx"
  ON "HandoffEvidence"("handoffId", "planRevision");

-- 8. Database-level immutability and identity guards.

-- 8.1 ProcessingHandoff identity is frozen at creation.
CREATE FUNCTION "prevent_processing_handoff_identity_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."processingRunId" IS DISTINCT FROM NEW."processingRunId"
    OR OLD."planRevision" IS DISTINCT FROM NEW."planRevision"
    OR OLD."logicalHandoffIndex" IS DISTINCT FROM NEW."logicalHandoffIndex"
    OR OLD."previousChunkId" IS DISTINCT FROM NEW."previousChunkId"
    OR OLD."nextChunkId" IS DISTINCT FROM NEW."nextChunkId"
  THEN
    RAISE EXCEPTION 'ProcessingHandoff immutable identity fields cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProcessingHandoff_prevent_identity_mutation"
BEFORE UPDATE ON "ProcessingHandoff"
FOR EACH ROW EXECUTE FUNCTION "prevent_processing_handoff_identity_mutation"();

-- 8.2 Left/right chunks must share run + plan revision, be adjacent and valid.
CREATE FUNCTION "validate_processing_handoff_chunks"()
RETURNS TRIGGER AS $$
DECLARE
  prev_chunk RECORD;
  next_chunk RECORD;
BEGIN
  SELECT "processingRunId", "planRevision", "chunkIndex", "status" INTO prev_chunk
    FROM "ProcessingChunk" WHERE "id" = NEW."previousChunkId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ProcessingHandoff previous chunk not found';
  END IF;
  SELECT "processingRunId", "planRevision", "chunkIndex", "status" INTO next_chunk
    FROM "ProcessingChunk" WHERE "id" = NEW."nextChunkId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ProcessingHandoff next chunk not found';
  END IF;
  IF prev_chunk."processingRunId" <> NEW."processingRunId"
    OR next_chunk."processingRunId" <> NEW."processingRunId"
  THEN
    RAISE EXCEPTION 'ProcessingHandoff chunks must belong to the same processing run';
  END IF;
  IF prev_chunk."planRevision" <> NEW."planRevision"
    OR next_chunk."planRevision" <> NEW."planRevision"
  THEN
    RAISE EXCEPTION 'ProcessingHandoff chunks must belong to the handoff plan revision';
  END IF;
  IF prev_chunk."chunkIndex" + 1 <> next_chunk."chunkIndex" THEN
    RAISE EXCEPTION 'ProcessingHandoff chunks must be adjacent';
  END IF;
  IF prev_chunk."status" <> 'SUCCEEDED' OR next_chunk."status" <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'ProcessingHandoff chunks must be valid (SUCCEEDED)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProcessingHandoff_validate_chunks"
BEFORE INSERT OR UPDATE ON "ProcessingHandoff"
FOR EACH ROW EXECUTE FUNCTION "validate_processing_handoff_chunks"();

-- 8.3 Assessments are immutable snapshots (non-terminal by design).
CREATE FUNCTION "prevent_handoff_assessment_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'HandoffAssessment is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HandoffAssessment_prevent_mutation"
BEFORE UPDATE ON "HandoffAssessment"
FOR EACH ROW EXECUTE FUNCTION "prevent_handoff_assessment_mutation"();

CREATE TRIGGER "HandoffAssessment_prevent_delete"
BEFORE DELETE ON "HandoffAssessment"
FOR EACH ROW EXECUTE FUNCTION "prevent_handoff_assessment_mutation"();

-- 8.4 AlignmentJob identity is frozen; externalJobId is set-once.
CREATE FUNCTION "prevent_alignment_job_identity_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."handoffId" IS DISTINCT FROM NEW."handoffId"
    OR OLD."idempotencyKey" IS DISTINCT FROM NEW."idempotencyKey"
    OR OLD."correlationHandle" IS DISTINCT FROM NEW."correlationHandle"
    OR OLD."windowStartMs" IS DISTINCT FROM NEW."windowStartMs"
    OR OLD."windowEndMs" IS DISTINCT FROM NEW."windowEndMs"
    OR OLD."methodDigest" IS DISTINCT FROM NEW."methodDigest"
    OR OLD."modelDigest" IS DISTINCT FROM NEW."modelDigest"
    OR OLD."configDigest" IS DISTINCT FROM NEW."configDigest"
  THEN
    RAISE EXCEPTION 'AlignmentJob immutable identity fields cannot change';
  END IF;
  IF OLD."externalJobId" IS NOT NULL
    AND NEW."externalJobId" IS DISTINCT FROM OLD."externalJobId"
  THEN
    RAISE EXCEPTION 'AlignmentJob externalJobId is set-once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AlignmentJob_prevent_identity_mutation"
BEFORE UPDATE ON "AlignmentJob"
FOR EACH ROW EXECUTE FUNCTION "prevent_alignment_job_identity_mutation"();

-- 8.5 Final evidence is terminal: append-only, never overwritten or deleted.
-- (The future fenced user-deletion path is a separate contract and would use a
-- dedicated definer function, not a plain DELETE through this trigger.)
CREATE FUNCTION "prevent_handoff_evidence_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'HandoffEvidence is final and immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "HandoffEvidence_prevent_mutation"
BEFORE UPDATE ON "HandoffEvidence"
FOR EACH ROW EXECUTE FUNCTION "prevent_handoff_evidence_mutation"();

CREATE TRIGGER "HandoffEvidence_prevent_delete"
BEFORE DELETE ON "HandoffEvidence"
FOR EACH ROW EXECUTE FUNCTION "prevent_handoff_evidence_mutation"();
