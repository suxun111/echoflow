import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { UploadRequest } from '@online-learning/contracts'
import { Icon } from '../../components/Icon'
import {
  completeUpload,
  createUploadTarget,
  getProcessingJob,
  listProcessingJobs,
  listPrivateCourses,
  putVideoFile,
  retryUpload,
  type PrivateCourseSummary,
  type ProcessingJob,
} from '../../lib/privateCourseApi'

type UploadModalProps = {
  onClose: () => void
  onOpenUploads: () => void
  onJobReady: (jobId: string) => void
}

type UploadsPageProps = {
  onUpload: () => void
  activeUploadId: string | null
  onOpenCourse: (courseId: string) => void
}

const initialForm: Pick<UploadRequest, 'title' | 'category' | 'accent' | 'level'> = {
  title: '',
  category: '旅行',
  accent: '美音',
  level: 'A2',
}

function stageLabel(stage: string) {
  const labels: Record<string, string> = {
    queued: '排队中', 'waiting-dependency': '等待 MOSS 服务恢复', downloading: '下载原视频', probing: '读取媒体信息', 'extracting-media': '提取音频与封面', 'moss-splitting': '切分音频片段', 'moss-submitting': '提交 MOSS', 'moss-transcribing': 'MOSS 转写与说话人识别', 'moss-recovery': '恢复异常音频片段', translating: '翻译字幕', completed: '已完成', failed: '处理失败', 'queue-failed': '队列不可用',
  }
  return labels[stage] ?? stage
}

function jobErrorText(job: ProcessingJob) {
  if (!job.error) return job.warnings.length ? job.warnings.join('；') : 'MOSS 转写、字幕翻译与私有课程保存会在这里显示真实状态。'
  return `${job.errorCode ? `${job.errorCode}：` : ''}${job.error}`
}

export function UploadModal({ onClose, onOpenUploads, onJobReady }: UploadModalProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [form, setForm] = useState(initialForm)
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const chooseFile = (candidate: File | undefined) => {
    if (!candidate) return
    if (candidate.type !== 'video/mp4' && !candidate.name.toLowerCase().endsWith('.mp4')) {
      setError('当前仅支持 MP4 视频文件')
      return
    }
    if (candidate.size > 2 * 1024 * 1024 * 1024) {
      setError('视频不能超过 2GB')
      return
    }
    setFile(candidate)
    setForm((current) => ({ ...current, title: current.title || candidate.name.replace(/\.mp4$/i, '') }))
    setError(null)
  }

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setDragging(false)
    chooseFile(event.dataTransfer.files[0])
  }

  const startUpload = async () => {
    if (!file) return setError('请选择要上传的 MP4 文件')
    if (!rightsConfirmed) return setError('请先确认拥有该视频的学习和处理权限')
    if (!form.title.trim()) return setError('请填写课程标题')
    setError(null)
    try {
      const target = await createUploadTarget({
        fileName: file.name,
        contentType: file.type || 'video/mp4',
        sizeBytes: file.size,
        rightsConfirmed: true,
        title: form.title.trim(),
        category: form.category,
        accent: form.accent,
        level: form.level,
      })
      setProgress(0)
      await putVideoFile(target.putUrl, file, setProgress)
      const completion = await completeUpload(target.uploadId)
      onJobReady(completion.job.id)
      onOpenUploads()
    } catch (uploadError) {
      setProgress(null)
      setError(uploadError instanceof Error ? uploadError.message : '上传失败，请重试')
    }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && progress === null && onClose()}>
    <section className="upload-modal" aria-labelledby="upload-title">
      <button className="modal-close" onClick={onClose} disabled={progress !== null} aria-label="关闭上传窗口"><Icon name="close"/></button>
      <span className="modal-icon"><Icon name="sparkles" size={25}/></span>
      <p className="modal-kicker">PRIVATE MP4 LESSON</p>
      <h2 id="upload-title">上传你的英语视频</h2>
      <p className="modal-intro">上传完成后会由 MOSS 生成带说话人的英文字幕，再尝试补齐中文翻译。课程仅开发者本人可见。</p>
      <button className={'drop-zone' + (dragging ? ' is-dragging' : '')} onClick={() => inputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop} disabled={progress !== null}>
        <Icon name="upload" size={28}/><strong>{file ? file.name : '拖放视频到这里'}</strong><span>{file ? `${Math.round(file.size / 1024 / 1024)} MB` : '或点击选择 MP4 文件，最大 2GB'}</span>
      </button>
      <input ref={inputRef} className="sr-only" type="file" accept="video/mp4,.mp4" onChange={(event) => chooseFile(event.target.files?.[0])}/>
      <div className="upload-form-grid">
        <label>课程标题<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} disabled={progress !== null}/></label>
        <label>难度<select value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value as UploadRequest['level'] })} disabled={progress !== null}><option>A1</option><option>A2</option><option>B1</option><option>B2</option><option>C1</option></select></label>
        <label>分类<input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} disabled={progress !== null}/></label>
        <label>口音<input value={form.accent} onChange={(event) => setForm({ ...form, accent: event.target.value })} disabled={progress !== null}/></label>
      </div>
      {progress !== null && <div className="browser-upload-progress" aria-live="polite"><span>正在上传到私有媒体库</span><span className="browser-upload-track"><i style={{ width: `${Math.round(progress * 100)}%` }}/></span><b>{Math.round(progress * 100)}%</b></div>}
      {error && <p className="upload-error" role="alert">{error}</p>}
      <label className="rights-check"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} disabled={progress !== null}/>我确认拥有该视频的学习和处理权限</label>
      <div className="modal-footer"><button onClick={onClose} disabled={progress !== null}>取消</button><button className="purple" onClick={() => void startUpload()} disabled={progress !== null}>{progress === null ? '上传并生成课程' : '正在上传'}</button></div>
    </section>
  </div>
}

export function UploadsPage({ onUpload, activeUploadId, onOpenCourse }: UploadsPageProps) {
  const [courses, setCourses] = useState<PrivateCourseSummary[]>([])
  const [job, setJob] = useState<ProcessingJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollNonce, setPollNonce] = useState(0)

  const refreshCourses = async () => {
    try {
      setCourses(await listPrivateCourses())
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法加载私有课程')
    }
  }

  useEffect(() => {
    let cancelled = false
    const loadInitialState = async () => {
      try {
        await refreshCourses()
        if (cancelled || activeUploadId) return
        const jobs = await listProcessingJobs()
        if (cancelled) return
        const next = jobs[0]
        if (next) setJob(next)
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '无法加载处理任务')
      }
    }
    void loadInitialState()
    return () => { cancelled = true }
  }, [activeUploadId])

  useEffect(() => {
    const pollingJobId = activeUploadId ?? job?.id
    if (!pollingJobId) return
    let cancelled = false
    let timer: number | undefined
    const controller = new AbortController()
    let delay = 2500
    const schedule = () => {
      timer = window.setTimeout(() => void poll(), delay)
      delay = Math.min(delay * 2, 15000)
    }
    const poll = async () => {
      try {
        const nextJob = await getProcessingJob(pollingJobId, controller.signal)
        if (cancelled) return
        setJob(nextJob)
        await refreshCourses()
        delay = 2500
        if (nextJob.status === 'queued' || nextJob.status === 'processing') schedule()
      } catch (pollError) {
        if (cancelled || controller.signal.aborted) return
        setError(pollError instanceof Error ? pollError.message : '无法读取处理任务')
        schedule()
      }
    }
    void poll()
    return () => { cancelled = true; controller.abort(); if (timer) window.clearTimeout(timer) }
  }, [activeUploadId, job?.id, pollNonce])

  const retry = async () => {
    if (!job) return
    try {
      setJob(await retryUpload(job.uploadId))
      setError(null)
      setPollNonce((value) => value + 1)
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : '任务重试失败')
    }
  }

  return <main className="simple-page">
    <div className="simple-heading"><div><p>MY PRIVATE COURSES</p><h1>个人上传</h1><span>本地 MP4、处理任务与生成的学习课程只对开发者本人可见。</span></div><button onClick={onUpload}><Icon name="upload"/>上传新视频</button></div>
    {error && <p className="upload-error page-error" role="alert">{error}</p>}
    {job && <section className="processing-card" aria-live="polite">
      <div className="processing-cover processing-cover-live"><span>{stageLabel(job.stage)}</span></div>
      <div className="processing-info"><span><Icon name="sparkles" size={15}/> {job.status === 'completed' ? '课程已就绪' : job.status === 'failed' ? '任务需要处理' : 'AI 正在生成课程'}</span><h3>{stageLabel(job.stage)}</h3><p>{jobErrorText(job)}</p><div className="task-progress"><i style={{ width: `${job.progress}%` }}/></div><small>{job.progress}% · {job.status === 'completed' ? '可以进入学习页' : job.status === 'failed' ? '可检查环境后重试' : '处理中'}</small></div>
      {job.status === 'failed' ? <button className="task-action" onClick={() => void retry()}>重试</button> : null}
    </section>}
    <section className="private-course-list" aria-label="我的私有课程">
      {courses.length === 0 ? <div className="upload-guide"><span className="modal-icon"><Icon name="sparkles" size={28}/></span><h2>从视频到课程，只需一次上传</h2><p>上传 MP4 后，系统会真实保存原视频、生成字幕任务，并在处理完成后提供音画同步的学习页。</p></div> : courses.map((course) => <article className="private-course-row" key={course.id}>
        <div className="private-course-cover">{course.coverUrl ? <img src={course.coverUrl} alt=""/> : <Icon name="play" size={24}/>}</div>
        <div><span>{course.status === 'ready' ? '已就绪' : course.status === 'failed' ? '处理失败' : '处理中'}</span><h2>{course.title}</h2><p>{course.cueCount} 条字幕 · 中文 {course.chineseCueCount}/{course.cueCount} · 词汇 {course.translatedVocabularyCount}/{course.vocabularyCount} · {course.durationSeconds ? `${Math.round(course.durationSeconds)} 秒` : '等待媒体分析'}</p></div>
        {course.status === 'ready' ? <button onClick={() => onOpenCourse(course.id)}>开始学习</button> : <small>{course.status === 'failed' ? '请在上方重试任务' : '处理完成后可播放'}</small>}
      </article>)}</section>
  </main>
}
