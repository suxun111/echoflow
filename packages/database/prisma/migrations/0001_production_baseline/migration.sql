-- Baseline schema for the production persistence layer.
CREATE TYPE "UserRole" AS ENUM ('LEARNER', 'EDITOR', 'ADMIN');
CREATE TYPE "AssetStatus" AS ENUM ('CANDIDATE', 'RIGHTS_REVIEW', 'APPROVED', 'PROCESSING', 'READY', 'PUBLISHED', 'REJECTED', 'ARCHIVED');
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'REJECTED', 'CHANGES_REQUESTED');
CREATE TYPE "JobType" AS ENUM ('TRANSCODE', 'TRANSCRIBE', 'TRANSLATE', 'SEGMENT', 'PUBLISH');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'REVIEW', 'COMPLETED', 'FAILED');

CREATE TABLE "User" ("id" TEXT NOT NULL, "phone" TEXT NOT NULL, "displayName" TEXT NOT NULL, "role" "UserRole" NOT NULL DEFAULT 'LEARNER', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id"));
CREATE TABLE "VideoAsset" ("id" TEXT NOT NULL, "sourcePlatform" TEXT, "sourceUrl" TEXT, "title" TEXT NOT NULL, "creator" TEXT NOT NULL, "coverUrl" TEXT NOT NULL, "storageKey" TEXT, "durationMs" INTEGER NOT NULL, "category" TEXT NOT NULL, "accent" TEXT NOT NULL, "level" TEXT NOT NULL, "status" "AssetStatus" NOT NULL DEFAULT 'CANDIDATE', "rightsNote" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id"));
CREATE TABLE "AuthorizationReview" ("id" TEXT NOT NULL, "assetId" TEXT NOT NULL, "reviewerId" TEXT NOT NULL, "decision" "ReviewDecision" NOT NULL, "note" TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AuthorizationReview_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Lesson" ("id" TEXT NOT NULL, "videoId" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT '', "publishedAt" TIMESTAMP(3), CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id"));
CREATE TABLE "SubtitleCue" ("id" TEXT NOT NULL, "lessonId" TEXT NOT NULL, "order" INTEGER NOT NULL, "startMs" INTEGER NOT NULL, "endMs" INTEGER NOT NULL, "english" TEXT NOT NULL, "chinese" TEXT NOT NULL DEFAULT '', "keywords" JSONB NOT NULL, "reviewed" BOOLEAN NOT NULL DEFAULT false, CONSTRAINT "SubtitleCue_pkey" PRIMARY KEY ("id"));
CREATE TABLE "LearningProgress" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "lessonId" TEXT NOT NULL, "currentCueId" TEXT, "completedCueIds" JSONB NOT NULL, "positionMs" INTEGER NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "LearningProgress_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Favorite" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "lessonId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id"));
CREATE TABLE "VocabularyItem" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "lessonId" TEXT NOT NULL, "cueId" TEXT, "word" TEXT NOT NULL, "meaning" TEXT NOT NULL, "mastery" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "VocabularyItem_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Recording" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "lessonId" TEXT NOT NULL, "cueId" TEXT, "storageKey" TEXT NOT NULL, "durationMs" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Recording_pkey" PRIMARY KEY ("id"));
CREATE TABLE "Upload" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "videoAssetId" TEXT, "originalName" TEXT NOT NULL, "contentType" TEXT NOT NULL, "sizeBytes" INTEGER NOT NULL, "storageKey" TEXT NOT NULL, "rightsConfirmed" BOOLEAN NOT NULL, "private" BOOLEAN NOT NULL DEFAULT true, "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Upload_pkey" PRIMARY KEY ("id"));
CREATE TABLE "ProcessingJob" ("id" TEXT NOT NULL, "uploadId" TEXT NOT NULL, "type" "JobType" NOT NULL, "status" "JobStatus" NOT NULL DEFAULT 'QUEUED', "progress" INTEGER NOT NULL DEFAULT 0, "attempts" INTEGER NOT NULL DEFAULT 0, "error" TEXT, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id"));
CREATE TABLE "VerificationCode" ("id" TEXT NOT NULL, "phone" TEXT NOT NULL, "codeHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "VerificationCode_pkey" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
CREATE UNIQUE INDEX "Lesson_videoId_key" ON "Lesson"("videoId");
CREATE UNIQUE INDEX "SubtitleCue_lessonId_order_key" ON "SubtitleCue"("lessonId", "order");
CREATE UNIQUE INDEX "LearningProgress_userId_lessonId_key" ON "LearningProgress"("userId", "lessonId");
CREATE UNIQUE INDEX "Favorite_userId_lessonId_key" ON "Favorite"("userId", "lessonId");
CREATE UNIQUE INDEX "ProcessingJob_uploadId_type_key" ON "ProcessingJob"("uploadId", "type");
CREATE INDEX "ProcessingJob_status_updatedAt_idx" ON "ProcessingJob"("status", "updatedAt");
CREATE INDEX "VerificationCode_phone_createdAt_idx" ON "VerificationCode"("phone", "createdAt");
CREATE INDEX "VerificationCode_expiresAt_idx" ON "VerificationCode"("expiresAt");

ALTER TABLE "AuthorizationReview" ADD CONSTRAINT "AuthorizationReview_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuthorizationReview" ADD CONSTRAINT "AuthorizationReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubtitleCue" ADD CONSTRAINT "SubtitleCue_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VocabularyItem" ADD CONSTRAINT "VocabularyItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VocabularyItem" ADD CONSTRAINT "VocabularyItem_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VocabularyItem" ADD CONSTRAINT "VocabularyItem_cueId_fkey" FOREIGN KEY ("cueId") REFERENCES "SubtitleCue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_cueId_fkey" FOREIGN KEY ("cueId") REFERENCES "SubtitleCue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;
