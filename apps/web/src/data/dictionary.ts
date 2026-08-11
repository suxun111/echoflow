import { getEnglishSurfaceWords, type LearningCue } from './library'

export type DictionaryEntry = {
  id: string
  word: string
  phonetic: string
  partOfSpeech: string
  meaning: string
  level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1'
  exampleEnglish: string
  exampleChinese: string
}

export type LessonVocabularyItem = {
  cue: LearningCue
  entry: DictionaryEntry
}

const dictionaryEntries: DictionaryEntry[] = [
  { id: 'welcome', word: 'Welcome', phonetic: '/ˈwelkəm/', partOfSpeech: 'interj. / v.', meaning: '欢迎；迎接', level: 'A1', exampleEnglish: 'Welcome back to the class.', exampleChinese: '欢迎回到课堂。' },
  { id: 'slow-english', word: 'slow English', phonetic: '/sləʊ ˈɪŋɡlɪʃ/', partOfSpeech: 'n. phr.', meaning: '慢速英语', level: 'A2', exampleEnglish: 'Slow English helps learners hear each word clearly.', exampleChinese: '慢速英语能帮助学习者清楚听到每个词。' },
  { id: 'taking-you-around', word: 'taking you around', phonetic: '/ˈteɪkɪŋ juː əˈraʊnd/', partOfSpeech: 'v. phr.', meaning: '带你四处看看；带你逛逛', level: 'B1', exampleEnglish: 'I am taking you around my neighbourhood today.', exampleChinese: '今天我带你逛逛我的社区。' },
  { id: 'coastal-town', word: 'coastal town', phonetic: '/ˈkəʊstl taʊn/', partOfSpeech: 'n. phr.', meaning: '海滨小镇', level: 'A2', exampleEnglish: 'They live in a quiet coastal town.', exampleChinese: '他们住在一个安静的海滨小镇。' },
  { id: 'quiet-place', word: 'quiet place', phonetic: '/ˈkwaɪət pleɪs/', partOfSpeech: 'n. phr.', meaning: '安静的地方', level: 'A2', exampleEnglish: 'This library is a quiet place to read.', exampleChinese: '这间图书馆是个适合阅读的安静地方。' },
  { id: 'something-to-see', word: 'something to see', phonetic: '/ˈsʌmθɪŋ tə siː/', partOfSpeech: 'n. phr.', meaning: '值得一看的事物；可看的景致', level: 'B1', exampleEnglish: 'There is always something to see by the river.', exampleChinese: '河边总有值得一看的景致。' },
  { id: 'harbour', word: 'harbour', phonetic: '/ˈhɑːbə(r)/', partOfSpeech: 'n.', meaning: '港口；港湾', level: 'A2', exampleEnglish: 'The boats return to the harbour at night.', exampleChinese: '船只在夜晚回到港口。' },
  { id: 'towards', word: 'towards', phonetic: '/təˈwɔːdz/', partOfSpeech: 'prep.', meaning: '朝；向', level: 'A2', exampleEnglish: 'Walk towards the station.', exampleChinese: '朝车站走去。' },
  { id: 'on-sunny-days', word: 'On sunny days', phonetic: '/ɒn ˈsʌni deɪz/', partOfSpeech: 'adv. phr.', meaning: '在晴天里', level: 'A2', exampleEnglish: 'On sunny days, we eat outside.', exampleChinese: '在晴天里，我们在户外吃饭。' },
  { id: 'watch-the-boats', word: 'watch the boats', phonetic: '/wɒtʃ ðə bəʊts/', partOfSpeech: 'v. phr.', meaning: '看船只', level: 'A2', exampleEnglish: 'We watch the boats from the pier.', exampleChinese: '我们从码头上看船只。' },
  { id: 'sea-breeze', word: 'sea breeze', phonetic: '/siː briːz/', partOfSpeech: 'n. phr.', meaning: '海风', level: 'A2', exampleEnglish: 'A cool sea breeze came through the window.', exampleChinese: '一阵凉爽的海风从窗边吹来。' },
  { id: 'in-the-middle-of', word: 'in the middle of', phonetic: '/ɪn ðə ˈmɪdl əv/', partOfSpeech: 'prep. phr.', meaning: '在……中间；在……期间', level: 'B1', exampleEnglish: 'We arrived in the middle of summer.', exampleChinese: '我们在盛夏时到达。' },
  { id: 'bring', word: 'bring', phonetic: '/brɪŋ/', partOfSpeech: 'v.', meaning: '带来；携带', level: 'A1', exampleEnglish: 'Please bring a light jacket.', exampleChinese: '请带一件薄外套。' },
  { id: 'with-me', word: 'with me', phonetic: '/wɪð miː/', partOfSpeech: 'prep. phr.', meaning: '和我一起；随身', level: 'A1', exampleEnglish: 'I always keep my notebook with me.', exampleChinese: '我总是随身带着笔记本。' },
  { id: 'repeat', word: 'repeat', phonetic: '/rɪˈpiːt/', partOfSpeech: 'v.', meaning: '重复；复述', level: 'A1', exampleEnglish: 'Repeat the phrase after me.', exampleChinese: '跟着我重复这句话。' },
  { id: 'each-sentence', word: 'each sentence', phonetic: '/iːtʃ ˈsentəns/', partOfSpeech: 'n. phr.', meaning: '每个句子', level: 'A1', exampleEnglish: 'Read each sentence aloud.', exampleChinese: '把每个句子朗读出来。' },
]

const entriesByNormalizedWord = new Map(dictionaryEntries.map((entry) => [normalizeVocabularyTerm(entry.word), entry]))

export function normalizeVocabularyTerm(value: string) {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z'\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function lookupDictionaryEntry(value: string) {
  return entriesByNormalizedWord.get(normalizeVocabularyTerm(value))
}

export function getVocabularyEntriesForHighlights(highlights: string[] = []) {
  const seen = new Set<string>()
  return highlights.flatMap((highlight) => {
    const entry = lookupDictionaryEntry(highlight)
    if (!entry || seen.has(entry.id)) return []
    seen.add(entry.id)
    return [entry]
  })
}

export function getLessonVocabulary(cues: LearningCue[]): LessonVocabularyItem[] {
  const seen = new Set<string>()
  return cues.flatMap((cue) => getVocabularyEntriesForHighlights(cue.highlight).flatMap((entry) => {
    if (seen.has(entry.id)) return []
    seen.add(entry.id)
    return [{ cue, entry }]
  }))
}

export type VocabularyTextSegment = {
  value: string
  entry?: DictionaryEntry
}

export type CueVocabularyWord = {
  word: string
  entry?: DictionaryEntry
}

export type CueVocabulary = {
  words: CueVocabularyWord[]
  phrases: DictionaryEntry[]
  coveredWordCount: number
  totalWordCount: number
}

export function getCueVocabulary(text: string, highlights: string[] = []): CueVocabulary {
  const words = getEnglishSurfaceWords(text).map((word) => ({ word, entry: lookupDictionaryEntry(word) }))
  const phrases = getVocabularyEntriesForHighlights(highlights)
  return {
    words,
    phrases,
    coveredWordCount: words.filter((item) => item.entry).length,
    totalWordCount: words.length,
  }
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function phrasePattern(value: string) {
  return normalizeVocabularyTerm(value)
    .split(' ')
    .map(escapeRegularExpression)
    .join('\\s+')
}

export function segmentCueText(text: string, highlights: string[] = []): VocabularyTextSegment[] {
  const entries = getVocabularyEntriesForHighlights(highlights)
  if (!entries.length) return [{ value: text }]

  const pattern = new RegExp(`\\b(${entries.sort((left, right) => right.word.length - left.word.length).map((entry) => phrasePattern(entry.word)).join('|')})\\b`, 'gi')
  return text.split(pattern).filter(Boolean).map((value) => ({
    value,
    entry: entries.find((entry) => normalizeVocabularyTerm(entry.word) === normalizeVocabularyTerm(value)),
  }))
}
