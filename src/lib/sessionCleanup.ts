import { supabase } from './supabase'

/** 앱이 sessionStorage에 직접 넣는 키들. 전부 "지금 이 사람이 방금 만든 내용"이라 로그인한
 * 사람이 바뀌면 남아 있으면 안 된다 — 계약서 분석 결과에는 매물 주소·보증금·위험 조항이,
 * 마음 상담 기록에는 사용자가 붙여넣은 문자/카톡 내용이 들어 있다.
 * (Supabase Auth 자체 세션은 localStorage에 따로 저장되며 signOut이 알아서 지우므로 여기 없다.) */
const APP_SESSION_KEYS = ['onzip:lastAnalysis', 'onzip:psychGuardMessages']

/** 현재 sessionStorage에 담긴 데이터가 "누구 것인지" 표시해 두는 키. 로그인 사용자 id를 넣고,
 * 비로그인 상태면 'anon'을 넣는다. */
const SESSION_OWNER_KEY = 'onzip:sessionOwner'

function clearAppSessionData() {
  for (const key of APP_SESSION_KEYS) {
    try {
      sessionStorage.removeItem(key)
    } catch {
      // private browsing 등으로 sessionStorage를 못 쓰는 환경 — 애초에 저장도 안 됐으므로 무시.
    }
  }
}

/**
 * 로그인한 사람이 바뀌면 앞사람이 남긴 분석 결과/상담 내용을 지운다.
 *
 * sessionStorage는 탭이 살아 있는 동안 유지되기 때문에, 같은 탭에서 A가 로그아웃하고 B가
 * 로그인하면 B에게 A의 데이터가 그대로 보이는 문제가 있었다(공용 PC에서 특히 위험).
 *
 * 소유자가 "바뀐" 경우에만 지우므로, 같은 사용자가 새로고침하거나 토큰이 자동 갱신될 때는
 * 보던 결과가 사라지지 않는다. 비로그인(anon) 상태에서 분석한 뒤 로그인하는 경우도 소유자
 * 변경으로 보고 지운다 — 공용 PC에서 앞사람이 비로그인으로 분석해 둔 내용을 뒷사람이 보는
 * 것도 똑같이 막아야 하기 때문이다.
 */
export function registerSessionCleanup() {
  supabase.auth.onAuthStateChange((_event, session) => {
    const currentOwner = session?.user?.id ?? 'anon'

    let previousOwner: string | null = null
    try {
      previousOwner = sessionStorage.getItem(SESSION_OWNER_KEY)
    } catch {
      return // sessionStorage를 못 쓰는 환경이면 남는 데이터도 없다.
    }

    if (previousOwner !== null && previousOwner !== currentOwner) {
      clearAppSessionData()
    }

    try {
      sessionStorage.setItem(SESSION_OWNER_KEY, currentOwner)
    } catch {
      // 저장 실패해도 다음 이벤트에서 previousOwner가 null이라 지우지 않을 뿐, 잘못 지우진 않는다.
    }
  })
}
