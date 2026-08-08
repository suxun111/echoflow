-- Add observability and dependency-waiting state without changing existing rows.
ALTER TYPE "JobStatus" ADD VALUE 'WAITING_DEPENDENCY';

ALTER TABLE "ProcessingJob"
  ADD COLUMN "stage" TEXT,
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "failedAt" TIMESTAMP(3);
