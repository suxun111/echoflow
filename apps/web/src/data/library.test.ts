import { describe, expect, it } from 'vitest'
import { getVocabularyEntriesForHighlights } from './dictionary'
import { getEnglishSurfaceWords, learningCues } from './library'

describe('learning cue translation coverage', () => {
  it('matches every English surface word to one contextual Chinese translation', () => {
    const coverage = learningCues.map((cue) => {
      const surfaceWords = getEnglishSurfaceWords(cue.english)
      return {
        id: cue.id,
        words: surfaceWords.length,
        translations: cue.wordTranslations.length,
        missing: surfaceWords.filter((word, index) => cue.wordTranslations[index]?.word !== word),
      }
    })

    expect(coverage).toEqual([
      { id: '1', words: 7, translations: 7, missing: [] },
      { id: '2', words: 10, translations: 10, missing: [] },
      { id: '3', words: 12, translations: 12, missing: [] },
      { id: '4', words: 12, translations: 12, missing: [] },
      { id: '5', words: 12, translations: 12, missing: [] },
      { id: '6', words: 12, translations: 12, missing: [] },
      { id: '7', words: 9, translations: 9, missing: [] },
      { id: '8', words: 10, translations: 10, missing: [] },
    ])
    expect(learningCues.flatMap((cue) => cue.wordTranslations).every((item) => item.translation.trim().length > 0)).toBe(true)
  })

  it('keeps complete phrase translations in addition to their component-word translations', () => {
    const completePhrases = learningCues.flatMap((cue) => getVocabularyEntriesForHighlights(cue.highlight)
      .filter((entry) => entry.word.includes(' '))
      .map((entry) => ({ cue, entry })))

    expect(completePhrases).toHaveLength(11)
    expect(completePhrases.map(({ entry }) => entry.word)).toEqual(expect.arrayContaining([
      'slow English', 'taking you around', 'coastal town', 'sea breeze', 'each sentence',
    ]))
    expect(learningCues[1].wordTranslations.map((item) => item.word)).toEqual(expect.arrayContaining(['taking', 'you', 'around', 'coastal', 'town']))
  })
})
