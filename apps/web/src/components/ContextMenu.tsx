import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

type ContextMenuProps = {
  word: string
  x: number
  y: number
  alreadyAdded: boolean
  onAdd: () => void
  onClose: () => void
}

export function ContextMenu({ word, x, y, alreadyAdded, onAdd, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  if (typeof document === 'undefined') return null

  const left = Math.min(Math.max(x, 12), Math.max(12, window.innerWidth - 224))
  const top = Math.min(Math.max(y, 12), Math.max(12, window.innerHeight - 72))

  return createPortal(
    <div className="word-context-menu" ref={menuRef} style={{ top, left }} role="menu" aria-label={`${word} 的操作菜单`}>
      <button type="button" role="menuitem" disabled={alreadyAdded} onClick={onAdd}>
        <Icon name="book" size={16} />
        <span>{alreadyAdded ? '已在生词本' : '加入生词本'}</span>
      </button>
    </div>,
    document.body,
  )
}
