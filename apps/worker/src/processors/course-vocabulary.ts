export type CourseVocabularyTermType = 'WORD' | 'PHRASE'

export type CourseVocabularyDraft = {
  word: string
  normalizedWord: string
  termType: CourseVocabularyTermType
  sourceSentence: string
  sourceCueId?: string
}

export type VocabularySourceCue = {
  id?: string
  english: string
  keywords?: unknown
}

const englishTermPattern = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g

export function normalizeCourseVocabularyTerm(value: string) {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z'\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sourceSurfaceForm(sentence: string, normalizedTerm: string) {
  if (!normalizedTerm.includes(' ')) {
    const match = sentence.match(englishTermPattern)?.find((token) => normalizeCourseVocabularyTerm(token) === normalizedTerm)
    return match ?? normalizedTerm
  }

  const phrasePattern = new RegExp(`(^|[^A-Za-z])(${normalizedTerm.split(' ').map((part) => part.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')).join('\\s+')})(?=$|[^A-Za-z])`, 'i')
  return sentence.match(phrasePattern)?.[2] ?? normalizedTerm
}

function readKeywordTerms(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map(normalizeCourseVocabularyTerm).filter(Boolean)
}

function sentenceContainsTerm(sentence: string, normalizedTerm: string) {
  const words = normalizeCourseVocabularyTerm(sentence).split(' ').filter(Boolean)
  const termWords = normalizedTerm.split(' ').filter(Boolean)
  return words.some((_, index) => termWords.every((word, offset) => words[index + offset] === word))
}

function sentenceWords(sentence: string) {
  const words: string[] = []
  for (const match of sentence.matchAll(englishTermPattern)) {
    const token = match[0]
    const start = match.index ?? 0
    const before = sentence[start - 1]
    const after = sentence[start + token.length]
    if (/\d/.test(before ?? '') || /\d/.test(after ?? '')) continue
    words.push(token)
  }
  return words
}

export function extractCourseVocabulary(cues: VocabularySourceCue[]) {
  const seen = new Set<string>()
  const terms: CourseVocabularyDraft[] = []

  for (const cue of cues) {
    const sentence = cue.english.trim()
    if (!sentence) continue
    const explicitTerms = readKeywordTerms(cue.keywords)
      .filter((term) => sentenceContainsTerm(sentence, term))
      .map((term) => ({ term, termType: term.includes(' ') ? 'PHRASE' as const : 'WORD' as const }))
    const candidates = [
      ...explicitTerms,
      ...sentenceWords(sentence).map((word) => ({ term: normalizeCourseVocabularyTerm(word), termType: 'WORD' as const })),
    ]

    for (const candidate of candidates) {
      if (!candidate.term || seen.has(candidate.term)) continue
      seen.add(candidate.term)
      terms.push({
        word: sourceSurfaceForm(sentence, candidate.term),
        normalizedWord: candidate.term,
        termType: candidate.termType,
        sourceSentence: sentence,
        sourceCueId: cue.id,
      })
    }
  }

  return terms
}

export function vocabularyTranslationInput(term: Pick<CourseVocabularyDraft, 'word' | 'sourceSentence'>) {
  return `${term.word} (English context: ${term.sourceSentence})`
}
