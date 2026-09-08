'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'
import { useBranding } from '@/components/branding-provider'
import { WorkspaceBrandHeader } from '@/components/workspace-brand'
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Headphones,
  Info,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react'

const savedUsernameKey = 'yanxing_saved_username'

function LoginHeroArt({ watermarkLogoUrl }: { watermarkLogoUrl: string }) {
  return (
    <div className="login-hero__art" aria-hidden="true">
      {/* 科技感网格与暗部遮罩 */}
      <div className="login-hero__grid" />
      <div className="login-hero__radial-mask" />
      <div className="login-hero__scanline" />

      {/* 呼吸光晕 */}
      <div className="login-hero__glow login-hero__glow--primary" />
      <div className="login-hero__glow login-hero__glow--secondary" />
      <div className="login-hero__glow login-hero__glow--accent" />

      {/* 漂浮光子微粒 (Floating Photons) */}
      <div className="login-hero__particles">
        <span className="login-particle login-particle--1" />
        <span className="login-particle login-particle--2" />
        <span className="login-particle login-particle--3" />
        <span className="login-particle login-particle--4" />
        <span className="login-particle login-particle--5" />
        <span className="login-particle login-particle--6" />
        <span className="login-particle login-particle--7" />
      </div>

      {/* 左下角：徽标与“研行”背景标识 */}
      <div className="login-hero__signature">
        <div className="login-hero__logo-watermark">
          <Image
            src={watermarkLogoUrl}
            alt=""
            className="login-hero__logo-watermark-img"
            width={2048}
            height={865}
            loading="eager"
            unoptimized
          />
        </div>
        <div className="login-hero__watermark">
          <span className="login-hero__glyph">研</span>
          <span className="login-hero__glyph login-hero__glyph--alt">行</span>
        </div>
      </div>

      {/* 侧脊极简编码 */}
      <div className="login-hero__spine">
        <span>YAN XING · INTELLIGENCE MATRIX</span>
        <span className="login-hero__spine-dot" />
        <span>YANXING-POLICY-AI.V26</span>
      </div>
    </div>
  )
}

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [capsLockActive, setCapsLockActive] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const { settings: branding } = useBranding()

  useEffect(() => {
    try {
      const savedUsername = window.localStorage.getItem(savedUsernameKey)
      if (savedUsername) {
        setUsername(savedUsername)
        setRemember(true)
      }
    } catch {
      // 存储被浏览器禁用时仍允许正常登录。
    }
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLockActive(event.getModifierState('CapsLock'))
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!username.trim()) {
      setError('请输入账号名称。')
      return
    }
    if (!password) {
      setError('请输入登录密码。')
      return
    }

    setError('')
    setNotice('')
    setSubmitting(true)
    try {
      if (remember) window.localStorage.setItem(savedUsernameKey, username.trim())
      else window.localStorage.removeItem(savedUsernameKey)
    } catch {
      // 记住账号是可选能力，不应阻断认证请求。
    }

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const body = (await response.json().catch(() => null)) as { error?: string } | null

      if (!response.ok) {
        setError(body?.error ?? '登录暂时不可用，请稍后再试。')
        setSubmitting(false)
        return
      }

      window.location.assign('/')
    } catch {
      setError('网络连接异常，请检查网络后重试。')
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      {/* 全屏前卫绿色环境底图 (Full Space Ambient Art) */}
      <LoginHeroArt watermarkLogoUrl={branding.loginWatermarkUrl} />

      {/* 顶部组织标识 (Top Brand Bar) */}
      <header className="login-header">
        <div aria-label={branding.displayText.replace(/\n/g, ' ')}>
          <WorkspaceBrandHeader />
        </div>
      </header>

      {/* 中央统一登录核心区 (Unified Center Hub) */}
      <div className="login-main">
        {/* 标语区 */}
        <div className="login-intro">
          <h1 className="login-intro__title">
            <span className="login-intro__line">
              <span className="login-intro__em">研</span>政策之道
            </span>
            <span className="login-intro__line">
              <span className="login-intro__em">行</span>产业之远
            </span>
          </h1>
          <p className="login-intro__subtitle">
            洞见趋势 · 赋能决策 · 驱动未来
          </p>
        </div>

        {/* 核心大悬浮卡片 */}
        <div className="login-card-stage">
          <div className="login-card-halo" aria-hidden="true" />
          <div className="login-card-motes" aria-hidden="true">
            <span className="login-card-mote login-card-mote--1" />
            <span className="login-card-mote login-card-mote--2" />
            <span className="login-card-mote login-card-mote--3" />
            <span className="login-card-mote login-card-mote--4" />
            <span className="login-card-mote login-card-mote--5" />
            <span className="login-card-mote login-card-mote--6" />
          </div>
          <div className="login-card">
          {/* 卡片顶部状态指示 */}
          <div className="login-card__topbar">
            <div className="login-card__security-pill" title="企业级端到端加密连接">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>安全连接服务访问</span>
            </div>
          </div>

          {/* 头部标题与身份说明 */}
          <header className="login-heading">
            <h2 id="login-title" className="login-heading__title">
              欢迎登录
            </h2>
            <p className="login-heading__subtitle">
              输入您的研究员或管理员账号进入研行工作台
            </p>
          </header>

          {/* 登录表单 */}
          <form onSubmit={submit} className="login-form" noValidate>
            {/* 账号输入框 */}
            <div className="login-field-group">
              <label htmlFor="login-username" className="login-field-label">
                账号名称
              </label>
              <div className="login-field">
                <span className="login-field__icon" aria-hidden="true">
                  <UserRound className="w-4 h-4" />
                </span>
                <input
                  id="login-username"
                  autoFocus
                  autoComplete="username"
                  aria-label="账号"
                  placeholder="请输入账号 / 邮箱"
                  required
                  maxLength={32}
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value)
                    if (error) setError('')
                  }}
                />
                {username && (
                  <button
                    type="button"
                    className="login-icon-button"
                    aria-label="清空账号输入"
                    title="清空"
                    onClick={() => setUsername('')}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* 密码输入框 */}
            <div className="login-field-group">
              <div className="login-field-group__header">
                <label htmlFor="login-password" className="login-field-label">
                  登录密码
                </label>
                {capsLockActive && (
                  <span className="login-field-capslock" role="alert">
                    <AlertCircle className="w-3 h-3 inline-block mr-1" />
                    大写锁定已开启
                  </span>
                )}
              </div>
              <div className="login-field">
                <span className="login-field__icon" aria-hidden="true">
                  <LockKeyhole className="w-4 h-4" />
                </span>
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  aria-label="密码"
                  placeholder="请输入密码"
                  required
                  maxLength={128}
                  value={password}
                  onKeyDown={handleKeyDown}
                  onKeyUp={handleKeyDown}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    if (error) setError('')
                  }}
                />
                <button
                  type="button"
                  className="login-icon-button"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  title={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* 异常反馈提示 */}
            {error && (
              <div className="login-message login-message--error" role="alert">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* 业务提示 */}
            {notice && (
              <div className="login-message login-message--notice" role="status">
                <Info className="w-4 h-4 flex-shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            {/* 选项栏 */}
            <div className="login-options">
              <label className="login-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span>记住登录账号</span>
              </label>
              <button
                type="button"
                className="login-forgot"
                onClick={() => {
                  setError('')
                  setNotice('如忘记密码，请联系系统管理员办理重置。')
                }}
              >
                忘记密码？
              </button>
            </div>

            {/* 提交按钮 */}
            <button
              type="submit"
              className="login-submit"
              disabled={submitting}
              aria-busy={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="login-spinner" aria-hidden="true" />
                  <span>正在验证身份...</span>
                </>
              ) : (
                <>
                  <span>进入研行工作台</span>
                  <ArrowRight className="login-submit__arrow w-4 h-4" aria-hidden="true" />
                </>
              )}
            </button>
          </form>

          {/* 卡片底部技术支持 */}
          <footer className="login-card__footer">
            <p>
              <Headphones className="w-3.5 h-3.5" aria-hidden="true" />
              <span>系统运维支持：研行产业政策研究团队</span>
            </p>
          </footer>
        </div>
        </div>
      </div>

      {/* 底部统一版权 */}
      <footer className="login-footer">
        <p>© 2026 研行产业政策研究团队</p>
      </footer>
    </main>
  )
}
