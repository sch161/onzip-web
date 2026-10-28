import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from './supabase'

export interface RawLawSearchResult {
  term: string
  definition: string | null
  dictionaryCode: string | null
  dictionaryLabel: string | null
  source: string | null
  detailUrl: string
}

export interface LawSearchResponse {
  query: string
  totalCnt: number
  truncated: boolean
  results: RawLawSearchResult[]
}

const CACHE_KEY = 'onzip:lawSearchCache'

function readCache(): Record<string, LawSearchResponse> {
  try {
    return JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeCache(cache: Record<string, LawSearchResponse>) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // storage full/unavailable — caching is just an optimization, safe to skip
  }
}

async function unwrapFunctionsError(error: NonNullable<Awaited<ReturnType<typeof supabase.functions.invoke>>['error']>): Promise<Error> {
  if (error instanceof FunctionsHttpError) {
    const parsed = await error.context.json().catch(() => null)
    return new Error(parsed?.error ?? error.message)
  }
  return new Error(error.message)
}

/** MOLEG_API_OC를 클라이언트에 노출하지 않기 위해 search-legal-terms Edge Function을 거친다.
 * 같은 검색어는 세션 내에서(sessionStorage) 캐싱해 반복 호출을 피한다.
 *
 * 2026-09 기준: 이 Edge Function은 법제처 오픈API의 IP 화이트리스트 요구사항과 Supabase Edge
 * Function의 고정 아웃바운드 IP 미지원이 부딪혀 항상 502로 실패한다(docs/PROJECT_OVERVIEW.md
 * 참고). 호출부는 정상 동작할 때를 그대로 대비해 두고, 실패는 호출자가 사용자에게 "지금은 이
 * 기능을 이용할 수 없습니다" 같은 안내로 보여주도록 한다. */
export async function searchLegalTermsLive(query: string): Promise<LawSearchResponse> {
  const cache = readCache()
  if (cache[query]) return cache[query]

  const { data, error } = await supabase.functions.invoke('search-legal-terms', { body: { query } })
  if (error) throw await unwrapFunctionsError(error)

  const result = data as LawSearchResponse
  cache[query] = result
  writeCache(cache)
  return result
}
