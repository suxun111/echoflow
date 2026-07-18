import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { learningCues, type LibraryVideo } from '../../data/library'
import { useRecorder } from '../../hooks/useRecorder'

function highlight(text: string, words: string[] = []) {
  if (!words.length) return text
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(pattern).map((part, index) => words.some((word) => word.toLowerCase() === part.toLowerCase()) ? <mark key={`${part}-${index}`}>{part}</mark> : part)
}

export function PracticePage({ video, onBack, favorite, onFavorite }: { video: LibraryVideo; onBack: () => void; favorite: boolean; onFavorite: () => void }) {
  const [current, setCurrent] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [tab, setTab] = useState<'双语' | '英文' | '中文' | '单词'>('双语')
  const [hiddenVideo, setHiddenVideo] = useState(false)
  const [dictation, setDictation] = useState(false)
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const cue = learningCues[current]
  const handleRecordingComplete = useCallback(async (blob: Blob) => { setRecordingUrl(URL.createObjectURL(blob)) }, [])
  const recorder = useRecorder(handleRecordingComplete)
  const go = (index: number) => setCurrent(Math.min(Math.max(index, 0), learningCues.length - 1))

  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl)
  }, [recordingUrl])

  return <div className="study-page"><header className="study-header"><button className="study-back" onClick={onBack}><Icon name="chevronLeft"/>返回课程库</button><div className="study-title"><div className="study-creator" style={{ background: video.color }}>{video.creator[0]}</div><div><h1>{video.title}</h1><p>{video.subtitle} · {video.creator}</p></div></div><div className="study-header-actions"><span>{video.level} · {video.accent}</span><button className={favorite ? 'saved' : ''} onClick={onFavorite}><Icon name="heart"/>{favorite ? '已收藏' : '收藏'}</button></div></header><main className="study-layout"><section className="video-column"><div className={`learning-player ${hiddenVideo ? 'video-hidden' : ''}`} style={{ backgroundImage: `url(${video.cover})` }}><div className="player-tint"/>{hiddenVideo ? <div className="listen-only"><Icon name="volume" size={36}/><strong>听力专注模式</strong><p>画面已隐藏，试着只通过声音理解内容</p></div> : <><div className="video-brand">SLOW ENGLISH <span>{video.level}</span></div><button className="center-play" onClick={() => setPlaying(!playing)}><Icon name={playing ? 'pause' : 'play'} size={34}/></button><div className="video-caption">{cue.english}</div></>}<div className="native-controls"><span>0:{cue.start.toString().padStart(2, '0')}</span><div className="native-track"><i style={{ width: `${(cue.start / 36) * 100}%` }}/></div><span>{video.duration}</span></div></div><div className="player-tools"><button onClick={() => setSpeed(speed === 1.5 ? .75 : speed + .25)}><strong>{speed}x</strong><span>倍速</span></button><button className={hiddenVideo ? 'active' : ''} onClick={() => setHiddenVideo(!hiddenVideo)}><Icon name="volume"/><span>隐藏视频</span></button><button onClick={() => go(current - 1)} disabled={current === 0}><Icon name="chevronLeft"/><span>上一句</span></button><button className="main-control" onClick={() => setPlaying(!playing)}><Icon name={playing ? 'pause' : 'play'}/><span>{playing ? '暂停' : '播放'}</span></button><button onClick={() => go(current + 1)} disabled={current === learningCues.length - 1}><Icon name="chevronRight"/><span>下一句</span></button><button className={loop ? 'active' : ''} onClick={() => setLoop(!loop)}><Icon name="repeat"/><span>单句循环</span></button><button className={dictation ? 'active' : ''} onClick={() => setDictation(!dictation)}><Icon name="note"/><span>听写</span></button><button><Icon name="fullscreen"/><span>全屏</span></button></div><section className="sentence-workbench"><div className="workbench-top"><span>第 {current + 1} / {learningCues.length} 句</span><span>0:{cue.start.toString().padStart(2, '0')} — 0:{cue.end.toString().padStart(2, '0')}</span></div>{dictation ? <div className="dictation-box"><p>听原声，写下你听到的句子</p><input placeholder="Type what you hear…"/><button onClick={() => setDictation(false)}>查看答案</button></div> : <><p className="focus-sentence">{highlight(cue.english, cue.highlight)}</p><p className="focus-translation">{cue.chinese}</p></>}<div className="workbench-actions"><button onClick={() => setPlaying(true)}><Icon name="volume"/>播放原句</button>{recorder.isRecording ? <button className="recording-button" onClick={recorder.stop}><span/>停止并保存</button> : <button onClick={recorder.start}><Icon name="microphone"/>跟读录音</button>}<button><Icon name="book"/>加入生词</button><button><Icon name="note"/>记笔记</button>{recordingUrl && <audio controls src={recordingUrl}/>}</div>{recorder.error && <p className="record-error">{recorder.error}</p>}</section></section><aside className="transcript-panel"><div className="transcript-tabs">{(['双语', '英文', '中文', '单词'] as const).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div><div className="transcript-heading"><div><span>AI 双语字幕</span><small><i/> 已人工校对</small></div><button><Icon name="settings" size={17}/></button></div>{tab === '单词' ? <VocabularyPanel/> : <ol className="cue-list">{learningCues.map((item, index) => <li key={item.id} className={index === current ? 'current' : ''}><button className="cue-select" onClick={() => go(index)}><span className="cue-index">{index === current ? <Icon name="play" size={13}/> : String(index + 1).padStart(2, '0')}</span><span className="cue-copy"><strong>{highlight(item.english, item.highlight)}</strong>{tab !== '英文' && <small>{item.chinese}</small>}<em>0:{item.start.toString().padStart(2, '0')} — 0:{item.end.toString().padStart(2, '0')}</em></span></button><div className="cue-mini-actions"><button><Icon name="heart" size={15}/></button><button><Icon name="microphone" size={15}/></button></div></li>)}</ol>}</aside></main></div>
}

function VocabularyPanel() {
  return <div className="vocab-panel"><p>本课重点词汇</p>{[['coastal', '沿海的；海岸的', 'B1'], ['harbour', '港口；港湾', 'A2'], ['sea breeze', '海风', 'B1']].map(([word, meaning, level]) => <button key={word}><span><strong>{word}</strong><small>{meaning}</small></span><em>{level}</em><Icon name="volume" size={16}/></button>)}</div>
}
