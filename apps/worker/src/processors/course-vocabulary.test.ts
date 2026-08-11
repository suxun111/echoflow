import { describe, expect, it } from 'vitest'
import { extractCourseVocabulary, normalizeCourseVocabularyTerm, vocabularyTranslationInput } from './course-vocabulary'

describe('course vocabulary extraction', () => {
  it('deduplicates meaningful terms while preserving explicit phrases and source context', () => {
    const terms = extractCourseVocabulary([
      { id: 'cue-1', english: 'We walk towards the coastal town.', keywords: ['coastal town'] },
      { id: 'cue-2', english: 'The coastal town is quiet.', keywords: ['coastal town'] },
    ])

    expect(terms.filter((term) => term.normalizedWord === 'coastal town')).toEqual([
      expect.objectContaining({ word: 'coastal town', termType: 'PHRASE', sourceCueId: 'cue-1', sourceSentence: 'We walk towards the coastal town.' }),
    ])
    expect(terms.filter((term) => term.normalizedWord === 'town')).toHaveLength(1)
    expect(terms.some((term) => term.normalizedWord === '01')).toBe(false)
  })

  it('drops punctuation and numeric fragments but keeps contractions and surface forms', () => {
    expect(normalizeCourseVocabularyTerm("  I'M — ready!  ")).toBe("i'm ready")
    const terms = extractCourseVocabulary([{ id: 'cue-1', english: "I'm ready — 2026!", keywords: [] }])
    expect(terms.map((term) => term.word)).toEqual(["I'm", 'ready'])
  })

  it('sends the term with its source sentence as context', () => {
    expect(vocabularyTranslationInput({ word: 'harbour', sourceSentence: 'We walk towards the harbour.' })).toContain('harbour')
    expect(vocabularyTranslationInput({ word: 'harbour', sourceSentence: 'We walk towards the harbour.' })).toContain('We walk towards the harbour.')
  })
})
