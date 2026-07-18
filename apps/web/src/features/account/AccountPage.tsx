import type { AppView } from '../../types'
import { Icon } from '../../components/Icon'

export function AccountPage({ view }: { view: AppView }) {
  const content = { history: ['学习记录', '你已经累计学习 6.4 小时，完成了 128 个句子。'], vocabulary: ['生词本', '12 个单词正在学习中，今天复习 5 个就能完成目标。'], settings: ['账户设置', '管理个人资料、学习目标、字幕偏好和通知设置。'] }[view as 'history' | 'vocabulary' | 'settings'] ?? ['发现课程', '更多精选内容正在整理中。']
  return <main className="simple-page"><div className="simple-heading"><div><p>YOUR ECHOFLOW</p><h1>{content[0]}</h1><span>{content[1]}</span></div></div><div className="simple-placeholder"><span className="modal-icon"><Icon name={view === 'vocabulary' ? 'book' : view === 'settings' ? 'settings' : 'clock'} size={28}/></span><h2>功能界面已纳入下一阶段</h2><p>当前原型优先展示资源库、学习页和个人上传的核心体验。</p></div></main>
}
