import { createPortal } from 'react-dom'
import type { DictionaryEntry } from '../data/dictionary'
import { Icon } from './Icon'

export type PopoverPosition = {
  top: number
  left: number
  bottom: number
}

type DictionaryPopoverProps = {
  word: string
  entry?: DictionaryEntry
  contextEnglish: string
  contextChinese: string
  position: PopoverPosition
  onClose: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}

export function DictionaryPopover({
  word,
  entry,
  contextEnglish,
  contextChinese,
  position,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: DictionaryPopoverProps) {
  if (typeof document === 'undefined') return null

  const viewportWidth = window.innerWidth || 1280
  const left = Math.min(Math.max(position.left, 12), Math.max(12, viewportWidth - 332))

  return createPortal(
    <section
      className="dictionary-popover"
      style={{ top: position.bottom + 10, left }}
      role="dialog"
      aria-label={`${word} 的词典注释`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="dictionary-popover-heading">
        <div>
          <strong>{entry?.word ?? word}</strong>
          {entry && <span>{entry.phonetic} · {entry.level}</span>}
        </div>
        <button type="button" className="dictionary-close" onClick={onClose} aria-label="关闭词典注释">
          <Icon name="close" size={14} />
        </button>
      </div>
      {entry ? (
        <>
          <p className="dictionary-meaning"><em>{entry.partOfSpeech}</em>{entry.meaning}</p>
          <div className="dictionary-example">
            <span>例句</span>
            <p>{entry.exampleEnglish}</p>
            <small>{entry.exampleChinese}</small>
          </div>
        </>
      ) : (
        <p className="dictionary-empty">本地词库暂未收录该单词。</p>
      )}
      <div className="dictionary-context">
        <span>本句语境</span>
        <p>{contextEnglish}</p>
        {contextChinese && <small>{contextChinese}</small>}
      </div>
    </section>,
    document.body,
  )
}
