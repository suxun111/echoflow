import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StatusBadge } from '@online-learning/ui'
import '@online-learning/ui/tokens.css'
import './styles.css'

const candidates = [
  { title: 'Life in a British Coastal Town', creator: 'Evie English', source: 'YouTube 候选', status: '待授权审核', tone: 'orange' as const },
  { title: 'How to Order Coffee Naturally', creator: 'Speak Easy', source: '运营上传', status: '字幕校对中', tone: 'purple' as const },
  { title: 'A Beautiful Train Journey', creator: 'Wander English', source: '授权媒资', status: '可发布', tone: 'green' as const },
]

function AdminApp() {
  return <div className="admin-shell"><aside><div className="admin-brand"><span>EF</span><strong>EchoFlow Admin</strong></div><nav><button className="active">工作台</button><button>候选内容</button><button>授权审核</button><button>媒资与字幕</button><button>处理任务</button><button>课程发布</button></nav><small>开发骨架 v0.1</small></aside><main><header><div><p>CONTENT OPERATIONS</p><h1>内容工作台</h1></div><button>＋ 新建候选内容</button></header><section className="stats"><article><span>待授权</span><strong>12</strong><small>3 项即将超时</small></article><article><span>处理中</span><strong>7</strong><small>Worker 状态正常</small></article><article><span>待校对</span><strong>4</strong><small>共 126 个字幕句</small></article><article><span>已发布</span><strong>38</strong><small>本周新增 6 项</small></article></section><section className="queue"><div className="section-title"><h2>需要处理</h2><button>查看全部</button></div><table><thead><tr><th>内容</th><th>来源</th><th>状态</th><th>操作</th></tr></thead><tbody>{candidates.map((item) => <tr key={item.title}><td><strong>{item.title}</strong><small>{item.creator}</small></td><td>{item.source}</td><td><StatusBadge tone={item.tone}>{item.status}</StatusBadge></td><td><button className="table-action">打开 →</button></td></tr>)}</tbody></table></section><section className="pipeline"><h2>媒体处理管线</h2><div><span>转码<strong>2</strong></span><i/><span>语音识别<strong>1</strong></span><i/><span>翻译分句<strong>3</strong></span><i/><span>人工审核<strong>4</strong></span><i/><span>待发布<strong>1</strong></span></div></section></main></div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><AdminApp /></StrictMode>)
