import { normalizeVocabularyTerm } from '../data/dictionary'

export const VOCABULARY_STORAGE_KEY = 'echoflow_vocabulary'
const VOCABULARY_CHANGE_EVENT = 'echoflow:vocabulary-change'

export type VocabularyEntry = {
  word: string
  normalizedWord: string
  meaning: string
  level: string
  exampleEnglish: string
  exampleChinese: string
  contextEnglish: string
  contextChinese: string
  lessonId: string
  lessonTitle: string
  cueId: string
  timestamp: string
  addedAt: string
}

export type AddVocabularyInput = Omit<VocabularyEntry, 'normalizedWord' | 'addedAt'> & {
  normalizedWord?: string
}

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function isVocabularyEntry(value: unknown): value is Omit<VocabularyEntry, 'level'> & { level?: unknown } {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<VocabularyEntry>
  return typeof entry.word === 'string' && typeof entry.normalizedWord === 'string' && typeof entry.addedAt === 'string'
}

function readVocabulary(): VocabularyEntry[] {
  if (!canUseStorage()) return []

  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(VOCABULARY_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter(isVocabularyEntry).map((entry) => ({ ...entry, level: typeof entry.level === 'string' ? entry.level : '未分级' }))
      : []
  } catch {
    return []
  }
}

function notifyVocabularyChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(VOCABULARY_CHANGE_EVENT))
}

function writeVocabulary(entries: VocabularyEntry[]) {
  if (!canUseStorage()) return
  window.localStorage.setItem(VOCABULARY_STORAGE_KEY, JSON.stringify(entries))
  notifyVocabularyChange()
}

export function getVocabulary() {
  return readVocabulary().sort((left, right) => right.addedAt.localeCompare(left.addedAt))
}

export function getVocabularyCount() {
  return readVocabulary().length
}

export function isInVocabulary(word: string) {
  const normalizedWord = normalizeVocabularyTerm(word)
  return Boolean(normalizedWord) && readVocabulary().some((entry) => entry.normalizedWord === normalizedWord)
}

export function addVocabularyWord(input: AddVocabularyInput) {
  const normalizedWord = normalizeVocabularyTerm(input.normalizedWord ?? input.word)
  if (!normalizedWord) return { added: false, entry: null }

  const current = readVocabulary()
  const existing = current.find((entry) => entry.normalizedWord === normalizedWord)
  if (existing) return { added: false, entry: existing }

  const entry: VocabularyEntry = {
    ...input,
    word: input.word.trim(),
    normalizedWord,
    addedAt: new Date().toISOString(),
  }

  writeVocabulary([...current, entry])
  return { added: true, entry }
}

export function removeVocabularyWord(normalizedWord: string) {
  const current = readVocabulary()
  const next = current.filter((entry) => entry.normalizedWord !== normalizedWord)
  if (next.length === current.length) return false
  writeVocabulary(next)
  return true
}

export function subscribeVocabulary(listener: () => void) {
  if (typeof window === 'undefined') return () => undefined

  const handleStorage = (event: StorageEvent) => {
    if (event.key === VOCABULARY_STORAGE_KEY) listener()
  }

  window.addEventListener(VOCABULARY_CHANGE_EVENT, listener)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(VOCABULARY_CHANGE_EVENT, listener)
    window.removeEventListener('storage', handleStorage)
  }
}
