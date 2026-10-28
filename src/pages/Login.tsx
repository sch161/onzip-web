import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import TopNav from '../components/TopNav'
import { supabase } from '../lib/supabase'

type OAuthProvider = 'google' | 'kakao'

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    navigate('/home')
  }

  async function handleOAuthLogin(provider: OAuthProvider) {
    setError(null)
    setOauthLoading(provider)

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/home` },
    })

    // On success the browser navigates away to the provider's consent screen,
    // so we only ever reach this line when the request itself failed.
    if (error) {
      setError(error.message)
      setOauthLoading(null)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <TopNav variant="auth" />
      <div className="mx-auto flex w-full max-w-[960px] flex-1 items-center gap-16 px-6 py-10 lg:grid lg:grid-cols-[1fr_440px]">
        <div className="hidden lg:block">
          <div className="mb-5 inline-flex items-center gap-[7px] rounded-chip bg-primary-bg px-3.5 py-[7px] text-[13px] font-bold text-primary-dark">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            상경 청년을 위한 안심 주거 파트너
          </div>
          <h1 className="text-balance text-[38px] font-extrabold leading-[1.2] tracking-tight text-text-dark">
            다시 만나서
            <br />
            반가워요
          </h1>
          <p className="mt-4 max-w-[420px] text-[16.5px] leading-relaxed text-text-gray">
            계약서 분석 기록과 관심 지역,
            <br />
            마음 상담 히스토리가 그대로 이어져요.
          </p>
        </div>

        <div className="w-full max-w-app lg:max-w-[440px] lg:rounded-card lg:border lg:border-border lg:bg-card lg:p-10 lg:shadow-card">
          <div className="flex flex-col items-center lg:items-start">
            <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-[20px] bg-primary-bg text-3xl lg:hidden">
              🏠
            </div>
            <h2 className="text-[34px] font-bold text-primary lg:text-xl lg:font-extrabold lg:text-text-dark">
              <span className="lg:hidden">ONZIP</span>
              <span className="hidden lg:inline">로그인</span>
            </h2>
            <p className="mt-2 text-balance text-center text-sm text-text-gray lg:hidden">
              AI로 전세사기 위험을 미리 확인하세요
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-4">
            <Input
              id="email"
              type="email"
              label="이메일"
              placeholder="example@zipup.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Input
              id="password"
              type="password"
              label="비밀번호"
              placeholder="비밀번호를 입력하세요"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            {error && <p className="text-xs font-medium text-danger">{error}</p>}

            <Button type="submit" className="mt-2" disabled={loading}>
              {loading ? '로그인 중...' : '로그인'}
            </Button>
          </form>

          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-text-lightgray">또는</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              onClick={() => handleOAuthLogin('kakao')}
              disabled={oauthLoading !== null}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-btn bg-[#FEE500] text-sm font-bold text-[#3A2A00] transition-opacity active:opacity-80 disabled:opacity-50"
            >
              <KakaoIcon />
              {oauthLoading === 'kakao' ? '이동 중...' : '카카오로 계속하기'}
            </button>
            <button
              type="button"
              onClick={() => handleOAuthLogin('google')}
              disabled={oauthLoading !== null}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-btn border border-border-input bg-white text-sm font-bold text-text-dark transition-opacity active:opacity-80 disabled:opacity-50"
            >
              <GoogleIcon />
              {oauthLoading === 'google' ? '이동 중...' : 'Google로 계속하기'}
            </button>
          </div>

          <p className="mt-8 text-center text-sm text-text-gray">
            계정이 없으신가요?{' '}
            <Link to="/signup" className="font-bold text-primary">
              회원가입
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.95v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.95A9 9 0 0 0 0 9c0 1.45.35 2.83.95 4.03l3-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .95 4.97l3 2.33C4.66 5.17 6.65 3.58 9 3.58z"
      />
    </svg>
  )
}

function KakaoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path
        fill="#3C1E1E"
        d="M9 1.5C4.31 1.5.5 4.5.5 8.2c0 2.36 1.56 4.43 3.92 5.62-.17.6-.62 2.2-.71 2.55-.11.42.16.42.33.3.14-.09 2.2-1.49 3.09-2.1.6.09 1.23.13 1.87.13 4.69 0 8.5-3 8.5-6.7S13.69 1.5 9 1.5z"
      />
    </svg>
  )
}
