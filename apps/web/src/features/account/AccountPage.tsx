import { useSyncExternalStore } from 'react'
import type { AppView } from '../../types'
import { Icon } from '../../components/Icon'
import {
  getVocabulary,
  getVocabularyCount,
  removeVocabularyWord,
  subscribeVocabulary,
} from '../../lib/vocabularyStore'

export function AccountPage({ view }: { view: AppView }) {
  if (view === 'vocabulary') return <VocabularyBook />

  const content = { history: ['学习记录', '你已经累计学习 6.4 小时，完成了 128 个句子。'], settings: ['账户设置', '管理个人资料、学习目标、字幕偏好和通知设置。'] }[view as 'history' | 'settings'] ?? ['发现课程', '更多精选内容正在整理中。']
  return <main className="simple-page"><div className="simple-heading"><div><p>YOUR ECHOFLOW</p><h1>{content[0]}</h1><span>{content[1]}</span></div></div><div className="simple-placeholder"><span className="modal-icon"><Icon name={view === 'settings' ? 'settings' : 'clock'} size={28}/></span><h2>功能界面已纳入下一阶段</h2><p>当前原型优先展示资源库、学习页和个人上传的核心体验。</p></div></main>
}

function VocabularyBook() {
  const vocabularyCount = useSyncExternalStore(subscribeVocabulary, getVocabularyCount, () => 0)
  const vocabulary = getVocabulary()

  return <main className="simple-page vocabulary-page">
    <div className="simple-heading">
      <div><p>YOUR ECHOFLOW</p><h1>生词本</h1><span>{vocabularyCount ? '已收录 ' + vocabularyCount + ' 个词条。' : '从字幕中收录想反复记住的单词或短语。'}</span></div>
    </div>
    {vocabulary.length ? <section className="vocabulary-book" aria-label="已保存的生词">
      <div className="vocabulary-book-heading"><span>单词</span><span>释义与语境</span><span>来源</span></div>
      <ul>
        {vocabulary.map((entry) => <li key={entry.normalizedWord}>
          <div className="vocabulary-word"><strong>{entry.word}</strong><small>{entry.level} · {entry.timestamp}</small></div>
          <div className="vocabulary-definition">
            <strong>{entry.meaning}</strong>
            <p>{entry.contextEnglish}</p>
            <small>{entry.contextChinese}</small>
          </div>
          <div className="vocabulary-source"><span>{entry.lessonTitle}</span><button type="button" onClick={() => removeVocabularyWord(entry.normalizedWord)} aria-label={'删除 ' + entry.word}><Icon name="close" size={15}/></button></div>
        </li>)}
      </ul>
    </section> : <div className="vocabulary-empty">
      <span className="modal-icon"><Icon name="book" size={28}/></span>
      <h2>生词本还是空的</h2>
      <p>在课程字幕里收录单词后，它们会出现在这里。</p>
    </div>}
  </main>
}
