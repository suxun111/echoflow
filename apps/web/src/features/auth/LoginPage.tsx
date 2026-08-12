import { FormEvent, useState } from 'react'
import type { ApiClient } from '../../lib/apiClient'

export function LoginPage({ api }: { api: ApiClient }) {
  const [phone, setPhone] = useState('+86')
  const [code, setCode] = useState('')
  const [developmentCode, setDevelopmentCode] = useState<string | null>(null)
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (step === 'phone') {
        const response = await api.requestOtp(phone.replace(/\s/g, ''))
        setDevelopmentCode(response.developmentCode ?? null)
        setStep('code')
      } else {
        await api.verifyOtp(phone.replace(/\s/g, ''), code)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return <main className="auth-page">
    <section className="auth-story" aria-label="EchoFlow 产品说明">
      <div className="auth-brand"><span className="brand-mark"><i/><i/><i/></span>EchoFlow</div>
      <p className="auth-eyebrow">PRIVATE SHADOWING STUDIO</p>
      <h1>让一段长播客，<br/>变成你能反复说出的英语。</h1>
      <p>上传自己的英语视频，保留原始清晰度。EchoFlow 会把它变成只属于你的逐句练习空间。</p>
      <div className="auth-timeline" aria-hidden="true"><i/><i/><i/><i/><i/></div>
    </section>
    <section className="auth-panel">
      <form onSubmit={submit}>
        <p className="auth-step">{step === 'phone' ? '受邀用户登录' : '输入验证码'}</p>
        <h2>{step === 'phone' ? '继续你的学习空间' : `验证码已发送至 ${phone}`}</h2>
        {step === 'phone'
          ? <label>手机号（含国家代码）<input autoFocus value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+8613800000000"/></label>
          : <label>6 位验证码<input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000"/></label>}
        {developmentCode && <p className="dev-code">本地开发验证码：<strong>{developmentCode}</strong></p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button disabled={busy || (step === 'phone' ? phone.length < 9 : code.length !== 6)}>{busy ? '正在连接…' : step === 'phone' ? '获取验证码' : '进入 EchoFlow'}</button>
        {step === 'code' && <button type="button" className="text-button" onClick={() => { setStep('phone'); setCode(''); setError('') }}>更换手机号</button>}
      </form>
      <p className="auth-privacy">你的媒体默认私有。管理员也不能直接播放或下载。</p>
    </section>
  </main>
}
