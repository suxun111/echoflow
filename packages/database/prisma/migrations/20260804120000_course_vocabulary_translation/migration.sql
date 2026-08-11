-- CreateEnum
CREATE TYPE "VocabularyTermType" AS ENUM ('WORD', 'PHRASE');

-- CreateEnum
CREATE TYPE "VocabularyTranslationSource" AS ENUM ('VOLCENGINE', 'LOCAL_FALLBACK', 'NONE');

-- CreateEnum
CREATE TYPE "VocabularyTranslationStatus" AS ENUM ('TRANSLATED', 'PENDING', 'RETRYABLE_FAILED', 'PERMANENT_FAILED');

-- CreateTable
CREATE TABLE "CourseVocabulary" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "cueId" TEXT,
    "word" TEXT NOT NULL,
    "normalizedWord" TEXT NOT NULL,
    "termType" "VocabularyTermType" NOT NULL,
    "sourceSentence" TEXT NOT NULL,
    "translation" TEXT NOT NULL DEFAULT '',
    "translationSource" "VocabularyTranslationSource" NOT NULL DEFAULT 'NONE',
    "translationStatus" "VocabularyTranslationStatus" NOT NULL DEFAULT 'PENDING',
    "translationErrorCode" TEXT,
    "translatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseVocabulary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourseVocabulary_lessonId_normalizedWord_key" ON "CourseVocabulary"("lessonId", "normalizedWord");

-- CreateIndex
CREATE INDEX "CourseVocabulary_lessonId_idx" ON "CourseVocabulary"("lessonId");

-- AddForeignKey
ALTER TABLE "CourseVocabulary" ADD CONSTRAINT "CourseVocabulary_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseVocabulary" ADD CONSTRAINT "CourseVocabulary_cueId_fkey" FOREIGN KEY ("cueId") REFERENCES "SubtitleCue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
