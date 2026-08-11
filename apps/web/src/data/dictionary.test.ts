import { describe, expect, it } from 'vitest'
import {
  getCueVocabulary,
  getLessonVocabulary,
  getVocabularyEntriesForHighlights,
  lookupDictionaryEntry,
  normalizeVocabularyTerm,
  segmentCueText,
} from './dictionary'
import { learningCues } from './library'

describe('local dictionary', () => {
  it('normalizes casing, punctuation, and repeated spaces for phrases', () => {
    expect(normalizeVocabularyTerm('  Sea   Breeze! ')).toBe('sea breeze')
    expect(lookupDictionaryEntry('COASTAL town.')?.meaning).toContain('海滨小镇')
  })

  it('maps every highlighted subtitle phrase to a local dictionary entry', () => {
    const highlights = learningCues.flatMap((cue) => cue.highlight ?? [])
    const entries = getVocabularyEntriesForHighlights(highlights)

    expect(entries).toHaveLength(highlights.length)
    expect(entries).toHaveLength(16)
    expect(entries.every((entry) => entry.meaning && entry.level)).toBe(true)
  })

  it('keeps full phrases intact in a cue and links every panel item to its source cue', () => {
    expect(segmentCueText(learningCues[1].english, learningCues[1].highlight).filter((segment) => segment.entry).map((segment) => segment.value)).toEqual([
      'taking you around',
      'coastal town',
    ])
    expect(getLessonVocabulary(learningCues)).toHaveLength(16)
  })

  it('does not activate a dictionary phrase that is absent from the cue highlights', () => {
    expect(segmentCueText(learningCues[7].english, learningCues[7].highlight).filter((segment) => segment.entry).map((segment) => segment.value)).toEqual([
      'repeat',
      'each sentence',
    ])
  })

  it('returns undefined for an unlisted term', () => {
    expect(lookupDictionaryEntry('unlisted')).toBeUndefined()
  })

  it('adapts a real cue without borrowing another sentence vocabulary', () => {
    const vocabulary = getCueVocabulary('Welcome to my coastal town.', ['coastal town'])

    expect(vocabulary.totalWordCount).toBe(5)
    expect(vocabulary.coveredWordCount).toBe(1)
    expect(vocabulary.words.map((item) => item.word)).toEqual(['Welcome', 'to', 'my', 'coastal', 'town'])
    expect(vocabulary.phrases.map((entry) => entry.word)).toEqual(['coastal town'])
    expect(vocabulary.words.filter((item) => !item.entry).map((item) => item.word)).toEqual(['to', 'my', 'coastal', 'town'])
  })
})
