import { useEffect, useMemo, useState } from 'react'
import type { AuthSession } from '../../types'
import { Icon } from '../../components/Icon'
import { BRAND_NAME } from '../../config/brand'
import { requestLoginCode, verifyLoginCode } from '../../lib/authApi'
import { libraryVideos } from '../../data/library'

type AuthPageProps = {
  onAuthenticated: (session: AuthSession) => void
  onCancel?: () => void
}

const phonePattern = /^1\d{10}$/

export function AuthPage({ onAuthenticated, onCancel }: AuthPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [developmentCode, setDevelopmentCode] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [requestingCode, setRequestingCode] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const featured = libraryVideos[0]
  const canRequestCode = countdown === 0 && !requestingCode
  const actionLabel = mode === 'login' ? `登录 ${BRAND_NAME}` : `注册 ${BRAND_NAME}`
  const subtitle = useMemo(() => mode === 'login'
    ? '用手机号继续学习，进度、收藏和录音会回到你的账户。'
    : '新手机号验证后会自动创建账户，之后仍用验证码登录。', [mode])

  useEffect(() => {
    if (countdown <= 0) return undefined
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [countdown])

  async function handleRequestCode() {
    setError('')
    setDevelopmentCode(null)
    if (!phonePattern.test(phone)) {
      setError('请输入 11 位中国大陆手机号。')
      return
    }

    setRequestingCode(true)
    try {
      const result = await requestLoginCode(phone)
      setCountdown(Math.min(60, result.expiresInSeconds))
      setDevelopmentCode(result.developmentCode ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '验证码发送失败，请稍后再试。')
    } finally {
      setRequestingCode(false)
    }
  }

  async function handleVerify() {
    setError('')
    if (!phonePattern.test(phone)) {
      setError('请输入 11 位中国大陆手机号。')
      return
    }
    if (!/^\d{6}$/.test(code)) {
      setError('请输入 6 位验证码。')
      return
    }

    setVerifying(true)
    try {
      onAuthenticated(await verifyLoginCode(phone, code))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '验证码校验失败，请重新输入。')
    } finally {
      setVerifying(false)
    }
  }

  return <main className="auth-page">
    <section className="auth-showcase" aria-label={`${BRAND_NAME} 学习入口`}>
      <div className="auth-brand"><span className="brand-mark"><i/><i/><i/></span><strong>{BRAND_NAME}</strong></div>
      <div className="auth-course" style={{ backgroundImage: `url(${featured.cover})` }}>
        <div className="auth-course-shade"/>
        <span><Icon name="sparkles" size={15}/> 今日推荐</span>
        <h1>让每一次登录，接上上次的声音。</h1>
        <p>{featured.subtitle} · {featured.level} · 已学习 38%</p>
        <div className="auth-course-progress"><i/></div>
      </div>
      <div className="auth-metrics">
        <span><strong>7 天</strong> 连续学习</span>
        <span><strong>128</strong> 已完成句子</span>
        <span><strong>12</strong> 生词复习</span>
      </div>
    </section>

    <section className="auth-panel" aria-label="登录注册表单">
      {onCancel && <button className="auth-close" onClick={onCancel} aria-label="返回课程库"><Icon name="close" size={18}/></button>}
      <p className="auth-eyebrow">YOUR {BRAND_NAME.toUpperCase()}</p>
      <h1>欢迎回到 {BRAND_NAME}</h1>
      <p className="auth-intro">{subtitle}</p>
      <div className="auth-tabs" role="tablist" aria-label="登录或注册">
        <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>登录</button>
        <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>注册</button>
      </div>
      <div className="auth-field">
        <label htmlFor="auth-phone">手机号</label>
        <div className="auth-input-row"><Icon name="user" size={18}/><input id="auth-phone" inputMode="numeric" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value.trim())} placeholder="13800000000"/></div>
      </div>
      <div className="auth-field">
        <label htmlFor="auth-code">验证码</label>
        <div className="auth-code-row">
          <div className="auth-input-row"><Icon name="note" size={18}/><input id="auth-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 位数字"/></div>
          <button type="button" onClick={handleRequestCode} disabled={!canRequestCode}>{requestingCode ? '发送中…' : countdown > 0 ? `${countdown} 秒后重试` : '获取验证码'}</button>
        </div>
      </div>
      {developmentCode && <p className="auth-dev-code">开发环境验证码：{developmentCode}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="auth-submit" type="button" onClick={handleVerify} disabled={verifying}>{verifying ? '正在进入…' : actionLabel}</button>
      <p className="auth-note">继续即代表你同意保存学习进度、收藏和个人练习记录。</p>
    </section>
  </main>
}
