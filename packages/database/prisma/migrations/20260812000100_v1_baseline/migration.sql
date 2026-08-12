-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('LEARNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED', 'DELETED');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('PERSONAL', 'WORKFLOW');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('CREATED', 'UPLOADING', 'VERIFYING', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('PROCESSING_PLAYBACK', 'PLAYABLE', 'FAILED', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "MediaObjectKind" AS ENUM ('ORIGINAL', 'PLAYBACK', 'NORMALIZED_AUDIO', 'AUDIO_CHUNK', 'ASR_RAW');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('QUEUED', 'PROCESSING', 'VALIDATING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProcessingStage" AS ENUM ('UPLOAD_VERIFIED', 'PROBING', 'PLAYBACK_READY', 'AUDIO_EXTRACTING', 'CHUNKING', 'TRANSCRIBING', 'MERGING', 'CUE_SEGMENTING', 'VALIDATING', 'TRANSCRIPT_READY', 'COURSE_READY');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('BUILDING', 'ACTIVE', 'SUPERSEDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LessonStatus" AS ENUM ('PROCESSING', 'READY', 'ARCHIVED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'LEARNER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "purpose" "OtpPurpose" NOT NULL DEFAULT 'LOGIN',
    "codeHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "requestId" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "replacedById" UUID,
    "lastUsedAt" TIMESTAMP(3),
    "userAgentHash" CHAR(64),
    "ipHash" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "sourceType" "SourceType" NOT NULL DEFAULT 'PERSONAL',
    "status" "UploadStatus" NOT NULL DEFAULT 'CREATED',
    "originalName" VARCHAR(512) NOT NULL,
    "contentType" VARCHAR(128) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "objectKey" VARCHAR(1024) NOT NULL,
    "providerUploadId" VARCHAR(512),
    "partSizeBytes" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "abortedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadPart" (
    "id" UUID NOT NULL,
    "uploadSessionId" UUID NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "etag" VARCHAR(512) NOT NULL,
    "checksumSha256" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "uploadSessionId" UUID,
    "sourceType" "SourceType" NOT NULL DEFAULT 'PERSONAL',
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'PROCESSING_PLAYBACK',
    "title" VARCHAR(300) NOT NULL,
    "originalName" VARCHAR(512) NOT NULL,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaObject" (
    "id" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "kind" "MediaObjectKind" NOT NULL,
    "bucket" VARCHAR(255) NOT NULL,
    "objectKey" VARCHAR(1024) NOT NULL,
    "versionId" VARCHAR(512),
    "contentType" VARCHAR(128) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "checksumSha256" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingRun" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "pipelineVersion" VARCHAR(128) NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "ProcessingStage" NOT NULL DEFAULT 'UPLOAD_VERIFIED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "requestId" VARCHAR(128),
    "errorCode" VARCHAR(128),
    "errorDetail" JSONB,
    "leaseOwner" VARCHAR(255),
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingChunk" (
    "id" UUID NOT NULL,
    "processingRunId" UUID NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "externalJobId" VARCHAR(512),
    "inputObjectKey" VARCHAR(1024) NOT NULL,
    "resultObjectKey" VARCHAR(1024),
    "errorCode" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "aggregateType" VARCHAR(128) NOT NULL,
    "aggregateId" VARCHAR(128) NOT NULL,
    "eventType" VARCHAR(128) NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptVersion" (
    "id" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "language" VARCHAR(16) NOT NULL DEFAULT 'en',
    "status" "TranscriptStatus" NOT NULL DEFAULT 'BUILDING',
    "durationMs" INTEGER NOT NULL,
    "cueCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubtitleCue" (
    "id" UUID NOT NULL,
    "transcriptVersionId" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "words" JSONB NOT NULL,

    CONSTRAINT "SubtitleCue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateLesson" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "transcriptVersionId" UUID,
    "title" VARCHAR(300) NOT NULL,
    "status" "LessonStatus" NOT NULL DEFAULT 'PROCESSING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivateLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningUnit" (
    "id" UUID NOT NULL,
    "lessonId" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "firstCueOrder" INTEGER NOT NULL,
    "lastCueOrder" INTEGER NOT NULL,

    CONSTRAINT "LearningUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningProgress" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "lessonId" UUID NOT NULL,
    "currentUnitId" UUID,
    "currentTranscriptVersionId" UUID,
    "currentCueId" UUID,
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "completedCueIds" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(128) NOT NULL,
    "resourceType" VARCHAR(128) NOT NULL,
    "resourceId" VARCHAR(128),
    "requestId" VARCHAR(128) NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "scope" VARCHAR(128) NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "OtpChallenge_phone_purpose_createdAt_idx" ON "OtpChallenge"("phone", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "OtpChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON "RefreshSession"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_replacedById_key" ON "RefreshSession"("replacedById");

-- CreateIndex
CREATE INDEX "RefreshSession_userId_expiresAt_idx" ON "RefreshSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "RefreshSession_familyId_idx" ON "RefreshSession"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_objectKey_key" ON "UploadSession"("objectKey");

-- CreateIndex
CREATE INDEX "UploadSession_ownerId_status_idx" ON "UploadSession"("ownerId", "status");

-- CreateIndex
CREATE INDEX "UploadSession_expiresAt_idx" ON "UploadSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_id_ownerId_key" ON "UploadSession"("id", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadPart_uploadSessionId_partNumber_key" ON "UploadPart"("uploadSessionId", "partNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_uploadSessionId_key" ON "MediaAsset"("uploadSessionId");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerId_status_createdAt_idx" ON "MediaAsset"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_id_ownerId_key" ON "MediaAsset"("id", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_uploadSessionId_ownerId_key" ON "MediaAsset"("uploadSessionId", "ownerId");

-- CreateIndex
CREATE INDEX "MediaObject_mediaAssetId_kind_idx" ON "MediaObject"("mediaAssetId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "MediaObject_bucket_objectKey_versionId_key" ON "MediaObject"("bucket", "objectKey", "versionId");

-- CreateIndex
CREATE INDEX "ProcessingRun_ownerId_status_idx" ON "ProcessingRun"("ownerId", "status");

-- CreateIndex
CREATE INDEX "ProcessingRun_status_leaseExpiresAt_idx" ON "ProcessingRun"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ProcessingRun_mediaAssetId_createdAt_idx" ON "ProcessingRun"("mediaAssetId", "createdAt");

-- CreateIndex
CREATE INDEX "ProcessingChunk_status_updatedAt_idx" ON "ProcessingChunk"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingChunk_processingRunId_chunkIndex_key" ON "ProcessingChunk"("processingRunId", "chunkIndex");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_idempotencyKey_key" ON "OutboxEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "TranscriptVersion_mediaAssetId_status_idx" ON "TranscriptVersion"("mediaAssetId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptVersion_mediaAssetId_version_key" ON "TranscriptVersion"("mediaAssetId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptVersion_id_mediaAssetId_key" ON "TranscriptVersion"("id", "mediaAssetId");

-- CreateIndex
CREATE INDEX "SubtitleCue_transcriptVersionId_startMs_idx" ON "SubtitleCue"("transcriptVersionId", "startMs");

-- CreateIndex
CREATE UNIQUE INDEX "SubtitleCue_transcriptVersionId_order_key" ON "SubtitleCue"("transcriptVersionId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "SubtitleCue_id_transcriptVersionId_key" ON "SubtitleCue"("id", "transcriptVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateLesson_mediaAssetId_key" ON "PrivateLesson"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateLesson_transcriptVersionId_key" ON "PrivateLesson"("transcriptVersionId");

-- CreateIndex
CREATE INDEX "PrivateLesson_ownerId_status_updatedAt_idx" ON "PrivateLesson"("ownerId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateLesson_id_ownerId_key" ON "PrivateLesson"("id", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateLesson_mediaAssetId_ownerId_key" ON "PrivateLesson"("mediaAssetId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateLesson_transcriptVersionId_mediaAssetId_key" ON "PrivateLesson"("transcriptVersionId", "mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateLesson_id_transcriptVersionId_key" ON "PrivateLesson"("id", "transcriptVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "LearningUnit_lessonId_order_key" ON "LearningUnit"("lessonId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "LearningUnit_id_lessonId_key" ON "LearningUnit"("id", "lessonId");

-- CreateIndex
CREATE INDEX "LearningProgress_lessonId_idx" ON "LearningProgress"("lessonId");

-- CreateIndex
CREATE UNIQUE INDEX "LearningProgress_ownerId_lessonId_key" ON "LearningProgress"("ownerId", "lessonId");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_resourceType_resourceId_idx" ON "AuditEvent"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditEvent_requestId_idx" ON "AuditEvent"("requestId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_ownerId_scope_key_key" ON "IdempotencyRecord"("ownerId", "scope", "key");

-- AddForeignKey
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "RefreshSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadPart" ADD CONSTRAINT "UploadPart_uploadSessionId_fkey" FOREIGN KEY ("uploadSessionId") REFERENCES "UploadSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploadSessionId_ownerId_fkey" FOREIGN KEY ("uploadSessionId", "ownerId") REFERENCES "UploadSession"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaObject" ADD CONSTRAINT "MediaObject_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingRun" ADD CONSTRAINT "ProcessingRun_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingRun" ADD CONSTRAINT "ProcessingRun_mediaAssetId_ownerId_fkey" FOREIGN KEY ("mediaAssetId", "ownerId") REFERENCES "MediaAsset"("id", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingChunk" ADD CONSTRAINT "ProcessingChunk_processingRunId_fkey" FOREIGN KEY ("processingRunId") REFERENCES "ProcessingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptVersion" ADD CONSTRAINT "TranscriptVersion_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubtitleCue" ADD CONSTRAINT "SubtitleCue_transcriptVersionId_fkey" FOREIGN KEY ("transcriptVersionId") REFERENCES "TranscriptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateLesson" ADD CONSTRAINT "PrivateLesson_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateLesson" ADD CONSTRAINT "PrivateLesson_mediaAssetId_ownerId_fkey" FOREIGN KEY ("mediaAssetId", "ownerId") REFERENCES "MediaAsset"("id", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateLesson" ADD CONSTRAINT "PrivateLesson_transcriptVersionId_mediaAssetId_fkey" FOREIGN KEY ("transcriptVersionId", "mediaAssetId") REFERENCES "TranscriptVersion"("id", "mediaAssetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningUnit" ADD CONSTRAINT "LearningUnit_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "PrivateLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_lessonId_ownerId_fkey" FOREIGN KEY ("lessonId", "ownerId") REFERENCES "PrivateLesson"("id", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_currentUnitId_lessonId_fkey" FOREIGN KEY ("currentUnitId", "lessonId") REFERENCES "LearningUnit"("id", "lessonId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_lessonId_currentTranscriptVersionId_fkey" FOREIGN KEY ("lessonId", "currentTranscriptVersionId") REFERENCES "PrivateLesson"("id", "transcriptVersionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_currentCueId_currentTranscriptVersionId_fkey" FOREIGN KEY ("currentCueId", "currentTranscriptVersionId") REFERENCES "SubtitleCue"("id", "transcriptVersionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- V1 invariants not expressible in Prisma schema
ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= "maxAttempts");
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_size_check" CHECK ("sizeBytes" > 0 AND "partSizeBytes" > 0);
ALTER TABLE "UploadPart" ADD CONSTRAINT "UploadPart_values_check" CHECK ("partNumber" > 0 AND "sizeBytes" > 0);
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_duration_check" CHECK ("durationMs" IS NULL OR "durationMs" > 0);
ALTER TABLE "MediaObject" ADD CONSTRAINT "MediaObject_size_check" CHECK ("sizeBytes" > 0);
ALTER TABLE "ProcessingRun" ADD CONSTRAINT "ProcessingRun_attempt_check" CHECK ("attempt" >= 0);
ALTER TABLE "ProcessingChunk" ADD CONSTRAINT "ProcessingChunk_time_check" CHECK ("startMs" >= 0 AND "endMs" > "startMs" AND "chunkIndex" >= 0 AND "attempt" >= 0);
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "TranscriptVersion" ADD CONSTRAINT "TranscriptVersion_values_check" CHECK ("version" > 0 AND "durationMs" > 0 AND "cueCount" >= 0);
ALTER TABLE "SubtitleCue" ADD CONSTRAINT "SubtitleCue_time_check" CHECK ("startMs" >= 0 AND "endMs" > "startMs" AND "order" >= 0);
ALTER TABLE "LearningUnit" ADD CONSTRAINT "LearningUnit_time_check" CHECK ("startMs" >= 0 AND "endMs" > "startMs" AND "order" >= 0 AND "firstCueOrder" >= 0 AND "lastCueOrder" >= "firstCueOrder");
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_position_check" CHECK ("positionMs" >= 0);
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_current_cue_check" CHECK (("currentCueId" IS NULL) = ("currentTranscriptVersionId" IS NULL));
CREATE UNIQUE INDEX "UploadSession_one_active_per_owner"
  ON "UploadSession" ("ownerId")
  WHERE "status" IN ('CREATED', 'UPLOADING', 'VERIFYING');
CREATE UNIQUE INDEX "MediaObject_current_object_key"
  ON "MediaObject" ("bucket", "objectKey")
  WHERE "versionId" IS NULL;
CREATE UNIQUE INDEX "TranscriptVersion_one_active_per_media"
  ON "TranscriptVersion" ("mediaAssetId")
  WHERE "status" = 'ACTIVE';
