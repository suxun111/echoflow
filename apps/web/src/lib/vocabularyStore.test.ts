import { afterEach, describe, expect, it } from 'vitest'
import {
  VOCABULARY_STORAGE_KEY,
  addVocabularyWord,
  getVocabulary,
  removeVocabularyWord,
} from './vocabularyStore'

const coastalWord = {
  word: 'Coastal town',
  meaning: '海滨小镇',
  level: 'A2',
  exampleEnglish: 'A coastal town is by the sea.',
  exampleChinese: '海滨小镇靠近海边。',
  contextEnglish: 'My little coastal town.',
  contextChinese: '我居住的海滨小镇。',
  lessonId: 'british-coast',
  lessonTitle: '英国海滨小镇的一天',
  cueId: '2',
  timestamp: '0:05 - 0:09',
}

afterEach(() => {
  window.localStorage.clear()
})

describe('vocabulary store', () => {
  it('persists a word and de-duplicates its normalized spelling', () => {
    expect(addVocabularyWord(coastalWord).added).toBe(true)
    expect(addVocabularyWord({ ...coastalWord, word: ' coastal   town! ' }).added).toBe(false)
    expect(getVocabulary()).toHaveLength(1)
    expect(getVocabulary()[0]).toMatchObject({ word: 'Coastal town', normalizedWord: 'coastal town', level: 'A2' })
  })

  it('removes an existing word', () => {
    addVocabularyWord(coastalWord)

    expect(removeVocabularyWord('coastal town')).toBe(true)
    expect(getVocabulary()).toEqual([])
    expect(window.localStorage.getItem(VOCABULARY_STORAGE_KEY)).toBe('[]')
  })
})
