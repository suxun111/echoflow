-- G2 resumable upload identity and immutable object evidence.
ALTER TABLE "UploadSession"
  ADD COLUMN "fileFingerprint" CHAR(64),
  ADD COLUMN "title" VARCHAR(300) NOT NULL DEFAULT 'Untitled video',
  ADD COLUMN "bucket" VARCHAR(255) NOT NULL DEFAULT 'online-learning';

ALTER TABLE "MediaObject"
  ADD COLUMN "etag" VARCHAR(512),
  ADD COLUMN "metadata" JSONB;

CREATE INDEX "UploadSession_ownerId_fileFingerprint_idx"
  ON "UploadSession" ("ownerId", "fileFingerprint");

ALTER TABLE "UploadSession"
  ADD CONSTRAINT "UploadSession_fingerprint_check"
  CHECK ("fileFingerprint" IS NULL OR "fileFingerprint" ~ '^[a-f0-9]{64}$');
