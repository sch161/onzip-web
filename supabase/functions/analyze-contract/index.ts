// Supabase Edge Function: analyze-contract
// Calls Gemini to assess 전세사기 (lease-fraud) risk for a property / uploaded document.
// The Gemini API key is read from Supabase Secrets (Deno.env) — it never reaches the client.
// Each analysis is also persisted to `analyses` via a service_role client (same pattern as analyze-chat).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { base64ToBytes, bytesToBase64 } from '../_shared/base64.ts'
import { mimeTypeToClovaFormat, runClovaOcr } from '../_shared/clovaOcr.ts'
import { findPiiMasks } from '../_shared/piiMask.ts'
import { applyBlackBoxes, ensureInitialized, prepareImageForOcr } from '../_shared/imageMask.ts'
import { jeonseRatioScore } from '../_shared/riskScore.ts'
import {
  calculateOverallScore,
  scoreToRiskLevel,
  type CategoryName,
  type ScoredCategory,
} from '../_shared/contractScore.ts'
import { filterRiskPatternsByKeywords, type RiskPattern } from '../_shared/riskPatternFilter.ts'
import { callVisionModel, isVisionProviderConfigured, missingKeyName } from '../_shared/callVisionModel.ts'

// AI 호출(Gemini/OpenAI 분기, 모델·키·재시도)은 _shared/callVisionModel.ts가 담당한다.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// OCR이 실패했거나 좌표를 읽지 못해 개인정보 마스킹을 보장할 수 없을 때 보여줄 메시지.
// 이 경우 원본이든 부분 마스킹본이든 Gemini에 절대 전송하지 않고 분석 자체를 중단한다.
const PII_MASK_FAILURE_MESSAGE =
  '문서에서 개인정보 보호 처리를 완료하지 못해 분석을 진행할 수 없습니다. 주민등록번호·계좌번호·연락처·이름 등 개인정보 부분을 직접 가리고 다시 올려주세요.'

interface AnalyzeRequest {
  address?: string
  deposit?: string
  buildingType?: string
  /** Base64-encoded scan of the 등기부등본/계약서, no data: prefix */
  fileBase64?: string
  fileMimeType?: string
}

const RISK_LEVELS = ['danger', 'warning', 'success'] as const

interface HugDefaulterMatch {
  name: string
  address: string
  similarity: number
}

// legal_provisions의 실제 컬럼(20260828000000_create_legal_provisions.sql 참고).
interface LegalProvisionRow {
  id: number
  law_name: string
  article: string
  title: string
  content: string
  plain_explanation: string
  source_url: string
}

// Gemini가 매기는 카테고리는 3개뿐이다 — 전세가율은 서버가 국토부 실거래가로 직접 계산해서
// 별도로 추가한다(계산 로직은 아래 computeJeonseRatioCategory 참고).
const GEMINI_CATEGORY_NAMES: readonly CategoryName[] = ['권리관계', '특약사항', '건물상태']

const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    // RAG 고도화: contract_risk_patterns의 실제 피해 사례 20건과 계약서를 대조한 AI 추정.
    // 실제 HUG 명단 대조가 아니라 사례 기반 "추정"이라는 점을 프론트에서도 명확히 구분해서
    // 보여줘야 한다 — 진짜 명단 대조 결과는 hugDefaulterMatch(아래)를 따로 둔다.
    hugLandlordCheck: {
      type: 'OBJECT',
      properties: {
        isBlacklisted: { type: 'BOOLEAN', description: '피해 사례 모음의 위험 패턴과 계약서 내용이 일치하는지 여부 (true/false)' },
        reason: {
          type: 'STRING',
          description:
            '일반인이 이해할 수 있는 자연스러운 문장으로 된 근거 설명, 1문장. "패턴 DB", "사례 3번"처럼 내부 자료 구조나 번호를 언급하는 표현은 금지.',
        },
      },
      required: ['isBlacklisted', 'reason'],
    },
    // overallScore/riskLevel은 여기 없다 — Gemini가 임의로 매기면 카테고리 점수와 수학적으로
    // 안 맞고 재현성도 없어서, 서버가 카테고리 점수의 가중평균으로 직접 계산한다
    // (_shared/contractScore.ts의 calculateOverallScore 참고).
    categories: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: '권리관계 | 특약사항 | 건물상태 중 하나' },
          score: { type: 'INTEGER', description: '0~100점, 높을수록 위험' },
          comment: { type: 'STRING', description: '1문장으로 간결하게' },
        },
        required: ['name', 'score', 'comment'],
      },
      description: '권리관계, 특약사항, 건물상태 3개 항목만. 전세가율은 서버가 별도로 계산해 추가하므로 포함하지 않는다.',
    },
    detectedClauses: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          summary: { type: 'STRING', description: '조항 원문 요약' },
          level: { type: 'STRING', enum: RISK_LEVELS },
          explanation: { type: 'STRING', description: '어려운 용어 해설 및 왜 위험/주의/안전한지에 대한 AI 설명, 1~2문장' },
          legalProvisionId: {
            type: 'INTEGER',
            nullable: true,
            description:
              '[관련 법 조항 후보] 목록에 있는 id 중 이 조항의 실제 법적 근거가 되는 것 하나. 후보 목록에 없는 id를 만들어내지 말 것. 명확히 들어맞는 후보가 없으면 반드시 null.',
          },
        },
        required: ['summary', 'level', 'explanation'],
      },
    },
    recommendedActions: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: '세입자가 임대인/중개사에게 요구해야 할 필수 방어 특약 및 실행 조치, 가장 중요한 3~5개',
    },
    aiComment: { type: 'STRING', description: '전체 상황에 대한 한국어 종합 코멘트 및 행동 요령, 2~3문장' },
    // landlordName은 여기 없다 — Gemini가 받는 이미지는 임대인 이름이 이미 마스킹된 상태라
    // 스스로 읽어낼 수 없다. 실제 값은 마스킹 전 CLOVA OCR로 서버가 직접 읽어 아래에서 주입한다.
  },
  required: ['hugLandlordCheck', 'categories', 'detectedClauses', 'recommendedActions', 'aiComment'],
}

// Gemini/OpenAI 호출·재시도 로직은 _shared/callVisionModel.ts로 옮겼다(기존 Gemini 재시도 동작 그대로).

// 응답 속도를 위해 프롬프트에 넣는 참고 사례는 짧게 자른다. 20건 전체를 원문 그대로 넣으면
// 입력 토큰이 커져 응답이 눈에 띄게 느려진다 — 패턴 판별에는 핵심 문장 정도로 충분하다.
function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
}

function formatRiskPatterns(patterns: RiskPattern[]): string {
  if (patterns.length === 0) return '(연동된 피해 사례 데이터가 없습니다)'
  return patterns
    .map(
      (p, i) =>
        `[사례 ${i + 1}] ${p.pattern_name} (${p.severity}): ${truncate(p.description, 120)} → ${truncate(p.recommended_action, 100)}`,
    )
    .join('\n')
}

// 사례(contract_risk_patterns)와 마찬가지로 원문을 그대로 넣으면 토큰이 커지므로 잘라 넣는다.
// 다만 legalProvisionId 매칭은 정확성이 중요하니 사례보다는 넉넉하게 자른다.
function formatLegalProvisions(provisions: LegalProvisionRow[]): string {
  if (provisions.length === 0) {
    return '(이번 계약서와 관련된 법 조항 후보가 없습니다 — 모든 detectedClauses의 legalProvisionId는 null로 두세요.)'
  }
  return provisions
    .map((p) => `[조항 id=${p.id}] ${p.law_name} ${p.article}(${p.title}): ${truncate(p.content, 200)}`)
    .join('\n')
}

function buildPrompt(input: AnalyzeRequest, referenceData: string, legalProvisionsData: string): string {
  return `당신은 대한민국 최고 수준의 부동산 임대차 계약서 분석 및 전세사기 예방 AI 전문가입니다.
아래 매물 정보, 첨부 문서, 그리고 [전세사기 및 독소조항 피해 사례 모음]을 바탕으로 위험도를 정밀 진단하세요.

[전세사기 및 독소조항 피해 사례 모음]
${referenceData}

[관련 법 조항 후보]
${legalProvisionsData}

[분석 대상 매물 정보]
- 매물 주소: ${input.address ?? '정보 없음'}
- 전세보증금: ${input.deposit ? `${input.deposit}만원` : '정보 없음'}
- 건물 유형: ${input.buildingType ?? '정보 없음'}

[엄격한 AI 분석 지침]
1. 제공된 [전세사기 및 독소조항 피해 사례 모음]의 실제 피해 조건들과 사용자가 제출한 계약서/등기부등본 텍스트를 1:1로 정밀 대조하세요.
2. 대항력 악용, 신탁 부동산, 바지사장 넘기기, 과도한 원상복구 등 위 사례와 일치하는 위험 패턴이 발견되면 hugLandlordCheck.isBlacklisted를 true로 설정하고, 권리관계·특약사항 등 관련 카테고리 점수를 명확히 높게(위험하게) 매기세요. hugLandlordCheck는 어디까지나 사례 기반 "추정"이며 실제 임대인 신원을 확인한 결과가 아니라는 점을 reason에서(1문장) 분명히 하되, reason은 반드시 일반인이 이해할 수 있는 자연스러운 문장으로 쓰세요 — "패턴 DB", "사례 3번"처럼 내부 자료 구조나 번호는 절대 언급하지 말고, 예를 들면 "이 계약서를 실제 전세사기 피해 사례들과 비교한 결과, 보증금을 못 받을 위험이 큰 조항이 발견됐어요." 같은 식으로 쓰세요.
3. 세입자가 이해하기 어려운 법률 용어(대항력, 신탁, 당해세 등)는 쉽게 풀어서 설명하고, 사례에 제시된 권장 대처 내용을 recommendedActions에 적극 반영하세요.
4. 제공된 사실과 사례에 철저히 기반하여 답변하고, 근거 없는 거짓말(환각 현상)을 엄격히 차단하세요.
5. 권리관계, 특약사항, 건물상태 3개 항목을 각각 0~100점(높을수록 위험)으로 평가하세요. comment는 1문장으로 간결하게 쓰세요. (전세가율은 서버가 실거래가 데이터로 직접 계산해 추가하므로 categories에 포함하지 마세요.)
6. 첨부된 문서가 있다면 위험하거나 주의가 필요한 조항을 detectedClauses에 구체적으로 추출하세요(explanation은 1~2문장). 첨부 문서가 없다면 빈 배열([])로 두세요.
7. 첨부된 문서 이미지에는 개인정보 보호를 위해 주민등록번호·계좌번호·연락처·성명 등 일부 영역이 검은 사각형으로 가려져 있습니다. 이는 정상적인 처리이니 가려진 부분을 추측해서 채우거나 문제로 언급하지 말고, 가려지지 않은 나머지 내용(보증금, 주소, 특약사항 등)만으로 분석하세요.
8. recommendedActions는 가장 중요한 3~5개만 문장으로 나열하세요.
9. aiComment는 2~3문장으로 핵심만 요약하세요.
10. 각 detectedClauses 항목의 legalProvisionId에는 [관련 법 조항 후보]에 나열된 id 중 그 조항의 실제 법적 근거가 되는 것 하나만 쓰세요. 후보 목록에 없는 id를 지어내지 말고, 명확히 들어맞는 후보가 없으면 반드시 null로 두세요.
11. 불필요하게 길게 쓰지 말고, 위 문장 수 제한을 반드시 지켜 간결하게 응답하세요. 반드시 지정된 JSON 스키마 형식으로만 응답을 반환하세요.`
}

/** contract_risk_patterns 전체(20건)를 가져온다. 실제로 프롬프트에 넣을 패턴은 이 중
 *  일부로 걸러진다(riskPatternFilter.ts의 filterRiskPatternsByKeywords 참고, 2026-08-28
 *  추가 — 20건을 매번 통째로 넣으면 Gemini 요청이 무거워져 타임아웃이 잦았다). id는 그
 *  키워드 매핑을 찾는 키로 쓰인다. */
async function fetchAllRiskPatterns(supabaseAdmin: ReturnType<typeof createClient>): Promise<RiskPattern[]> {
  const { data, error } = await supabaseAdmin
    .from('contract_risk_patterns')
    .select('id, pattern_name, description, severity, recommended_action')

  if (error) {
    console.error('fetchAllRiskPatterns failed, continuing without reference cases', error)
    return []
  }
  return data ?? []
}

/** 매칭된(=프롬프트에 실제로 들어가는) 위험 패턴에 pattern_legal_provisions로 연결된 법
 *  조문만 가져온다. 패턴-조문 매핑이 다대다라 legal_provision_id가 중복될 수 있으므로
 *  Map으로 중복 제거한다. 20건 전체가 아니라 이미 걸러진 소수 패턴 기준이라 항상 가볍다. */
async function fetchLegalProvisionsForPatterns(
  supabaseAdmin: ReturnType<typeof createClient>,
  patternIds: number[],
): Promise<LegalProvisionRow[]> {
  if (patternIds.length === 0) return []

  const { data: links, error: linkError } = await supabaseAdmin
    .from('pattern_legal_provisions')
    .select('legal_provision_id')
    .in('pattern_id', patternIds)

  if (linkError) {
    console.error('fetchLegalProvisionsForPatterns (links) failed, continuing without legal provisions', linkError)
    return []
  }

  const linkRows = (links ?? []) as { legal_provision_id: number }[]
  const legalProvisionIds = [...new Set(linkRows.map((l) => l.legal_provision_id))]
  if (legalProvisionIds.length === 0) return []

  const { data: provisions, error: provisionError } = await supabaseAdmin
    .from('legal_provisions')
    .select('id, law_name, article, title, content, plain_explanation, source_url')
    .in('id', legalProvisionIds)

  if (provisionError) {
    console.error('fetchLegalProvisionsForPatterns (provisions) failed, continuing without legal provisions', provisionError)
    return []
  }
  return provisions ?? []
}

async function resolveUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null

  const token = authHeader.slice('Bearer '.length)
  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser(token)
  return user?.id ?? null
}

/** Gemini가 돌려준 categories 배열에서 기대하는 3개 카테고리만 안전하게 뽑아낸다. Gemini 응답은
 *  타입이 강제되지 않는 외부 텍스트라, 이름이 빠지거나 score가 이상한 형식으로 와도 죽지 않고
 *  해당 카테고리를 "데이터 없음"으로 처리해 종합 점수 계산에서 자연스럽게 제외되게 한다. */
function coerceGeminiCategories(raw: unknown): ScoredCategory[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []

  return GEMINI_CATEGORY_NAMES.map((name) => {
    const match = list.find((c) => c && c.name === name)
    const rawScore = match?.score
    if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
      console.error(`Gemini response missing/invalid score for category "${name}", excluding from overall score`)
      return { name, score: null, comment: '이 항목에 대한 분석 결과를 받지 못했어요.' }
    }
    return {
      name,
      score: Math.max(0, Math.min(100, Math.round(rawScore))),
      comment: typeof match?.comment === 'string' ? match.comment : '',
    }
  })
}

/** Gemini가 돌려준 detectedClauses의 legalProvisionId를, 서버가 실제로 프롬프트에 제공했던
 *  legal_provisions 중에서만 매칭해 완전한 조문 정보로 치환한다. Gemini가 후보에 없는 id를
 *  지어내거나(환각) 이상한 타입을 보내도 조용히 null로 처리한다 — "제공된 후보 중에서만
 *  선택"이라는 프롬프트 지침을 서버에서도 강제하는 방어 코드다. */
function resolveDetectedClauses(raw: unknown, legalProvisionById: Map<number, LegalProvisionRow>) {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []

  return list.map((clause) => {
    const rawId = clause.legalProvisionId
    const provision = typeof rawId === 'number' ? legalProvisionById.get(rawId) : undefined

    return {
      summary: clause.summary,
      level: clause.level,
      explanation: clause.explanation,
      legalProvision: provision
        ? {
            lawName: provision.law_name,
            article: provision.article,
            title: provision.title,
            plainExplanation: provision.plain_explanation,
            sourceUrl: provision.source_url,
          }
        : null,
    }
  })
}

interface RegionMatch {
  region_code: string
  region_name: string
  avg_sale_price: number | null
  villa_avg_sale_price: number | null
}

// "다세대주택"이 이 서비스의 기본 건물 유형 placeholder이고 실제로 전세사기 위험이 훨씬 크게
// 발생하는 쪽이라, 건물 유형에 "아파트"가 명시되지 않은 이상 빌라(연립다세대) 시세를 기본으로
// 쓴다. 선택된 쪽 데이터가 그 달에 없으면(null) 반대쪽으로 대체한다.
function pickEffectiveSalePrice(
  buildingType: string | undefined,
  avgSalePrice: number | null,
  villaAvgSalePrice: number | null,
): number | null {
  const isApartment = (buildingType ?? '').includes('아파트')
  const primary = isApartment ? avgSalePrice : villaAvgSalePrice
  const fallback = isApartment ? villaAvgSalePrice : avgSalePrice
  return primary ?? fallback ?? null
}

/** 전세가율 카테고리를 서버에서 직접 계산한다: 계약서의 보증금을 매물 주소가 속한 지역의 평균
 *  매매가와 비교한다(안심 시그널 맵과 동일한 jeonseRatioScore 곡선 재사용, 점수 방향도 동일하게
 *  "높을수록 위험"). 주소 매칭 실패, 보증금 미입력, 해당 지역 시세 데이터 없음 등 어떤 이유로든
 *  계산할 근거가 없으면 score: null("데이터 없음")을 반환한다 — 임의 점수를 매기지 않고 종합
 *  점수 계산에서 이 항목을 제외시키기 위함(calculateOverallScore가 자동으로 처리). */
async function computeJeonseRatioCategory(
  supabaseAdmin: ReturnType<typeof createClient>,
  input: AnalyzeRequest,
): Promise<ScoredCategory> {
  const noData = (comment: string): ScoredCategory => ({ name: '전세가율', score: null, comment })

  if (!input.address?.trim()) return noData('매물 주소가 없어 전세가율을 계산할 수 없어요.')

  const depositNum = Number(input.deposit)
  if (!input.deposit || !Number.isFinite(depositNum) || depositNum <= 0) {
    return noData('보증금 정보가 없어 전세가율을 계산할 수 없어요.')
  }

  const { data, error } = await supabaseAdmin.rpc('match_region_by_address', { input_address: input.address })
  if (error) {
    console.error('match_region_by_address failed, excluding 전세가율 from score', error)
    return noData('주소로 지역 시세 데이터를 찾는 중 문제가 발생했어요.')
  }

  const region = (data as RegionMatch[] | null)?.[0]
  if (!region) return noData('주소와 일치하는 지역 시세 데이터를 찾지 못했어요. 데이터 없음으로 처리했어요.')

  const salePrice = pickEffectiveSalePrice(input.buildingType, region.avg_sale_price, region.villa_avg_sale_price)
  if (salePrice == null || salePrice <= 0) {
    return noData(`${region.region_name}의 최근 실거래가 데이터가 아직 없어 데이터 없음으로 처리했어요.`)
  }

  const ratio = (depositNum / salePrice) * 100
  return {
    name: '전세가율',
    score: Math.round(jeonseRatioScore(ratio)),
    comment: `${region.region_name} 평균 매매가 대비 보증금 비율은 약 ${Math.round(ratio)}%예요.`,
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  if (!isVisionProviderConfigured()) {
    console.error(`${missingKeyName()} is not set in Supabase Secrets`)
    return jsonResponse({ error: 'AI 분석 기능이 설정되지 않았습니다. 관리자에게 문의하세요.' }, 500)
  }

  let input: AnalyzeRequest
  try {
    input = await req.json()
  } catch {
    return jsonResponse({ error: '요청 형식이 올바르지 않습니다.' }, 400)
  }

  if (!input.address && !input.fileBase64) {
    return jsonResponse({ error: '매물 주소 또는 분석할 문서가 필요합니다.' }, 400)
  }

  // 임대인 이름은 OCR로 직접 읽어 HUG 명단 조회에만 쓴다 — Gemini는 마스킹된 이미지만 보므로
  // 이 이름을 알 방법이 없다. 파일이 없으면(주소만으로 분석) 빈 문자열로 남아 HUG 조회를 건너뛴다.
  let landlordNameFromOcr = ''

  // contract_risk_patterns 필터링(아래 참고)에 쓸 OCR 원문. 파일이 없으면 빈 문자열로 남고,
  // filterRiskPatternsByKeywords는 빈 문자열이면 자동으로 전체 패턴 폴백을 반환한다.
  let ocrTextForPatternMatch = ''

  // 파이프라인 단계별 소요 시간(ms). 파일 첨부가 없으면 리사이즈/OCR/마스킹 관련 키는 아예
  // 채워지지 않는다(해당 단계 자체가 실행되지 않으므로). 요청 하나가 끝날 때 한 번에 로그로
  // 남겨야 "이번 요청은 OCR이 느렸다/Gemini가 느렸다"를 바로 구분할 수 있다.
  const stageTimingsMs: Record<string, number> = {}

  if (input.fileBase64 && input.fileMimeType) {
    if (!mimeTypeToClovaFormat(input.fileMimeType)) {
      return jsonResponse({ error: '이미지 파일(JPG, PNG)만 업로드할 수 있습니다.' }, 400)
    }

    // magick-wasm은 첫 호출(콜드 스타트) 시 WASM 바이너리를 컴파일하는데, 이 컴파일 자체가 순수
    // CPU 연산이라 리사이즈 시간에 섞이면 "이미지 처리가 느리다"와 "콜드 스타트라 느리다"를 구분할
    // 수 없다. prepareImageForOcr 호출 전에 미리 불러 wasmInit을 별도 항목으로 잰다(멱등이라
    // prepareImageForOcr/applyBlackBoxes 내부에서 다시 불러도 캐시된 Promise를 재사용할 뿐이다).
    const wasmInitStart = Date.now()
    try {
      await ensureInitialized()
    } catch (err) {
      console.error('magick-wasm initialize failed, blocking analysis (cannot guarantee PII masking)', err)
      return jsonResponse({ error: PII_MASK_FAILURE_MESSAGE }, 422)
    }
    stageTimingsMs.wasmInit = Date.now() - wasmInitStart

    // 해상도가 큰 사진은 OCR로 보내기 전에 먼저 축소·PNG로 정규화한다 — 이후 OCR 좌표와 마스킹이
    // 항상 이 바이트 기준으로 일치하게 하기 위함(원본 그대로 OCR에 보내고 나중에 별도로 축소하면
    // 좌표가 어긋난다). 실패하면 마스킹을 보장할 수 없으므로 분석을 중단한다.
    let workingImageBytes: Uint8Array
    try {
      const t0 = Date.now()
      workingImageBytes = await prepareImageForOcr(base64ToBytes(input.fileBase64))
      stageTimingsMs.resize = Date.now() - t0
    } catch (err) {
      console.error('Image normalize/resize failed, blocking analysis (cannot guarantee PII masking)', err)
      return jsonResponse({ error: PII_MASK_FAILURE_MESSAGE }, 422)
    }

    let ocrFields: Awaited<ReturnType<typeof runClovaOcr>>
    try {
      const t0 = Date.now()
      ocrFields = await runClovaOcr(bytesToBase64(workingImageBytes), 'png')
      stageTimingsMs.clovaOcr = Date.now() - t0
    } catch (err) {
      console.error('CLOVA OCR failed, blocking analysis (cannot guarantee PII masking)', err)
      return jsonResponse({ error: PII_MASK_FAILURE_MESSAGE }, 422)
    }

    if (ocrFields.length === 0) {
      console.error('CLOVA OCR returned no fields, blocking analysis (cannot guarantee PII masking)')
      return jsonResponse({ error: PII_MASK_FAILURE_MESSAGE }, 422)
    }

    // 마스킹 전 원문 그대로 합쳐 둔다 — PII가 섞여 있지만 이 문자열은 패턴 키워드 매칭에만
    // 쓰이고(리스크 패턴을 추리는 용도) 로그로 남기거나 Gemini에 보내지 않는다.
    ocrTextForPatternMatch = ocrFields.map((f) => f.text).join(' ')

    const piiDetectStart = Date.now()
    const { boxes, landlordName, stats } = findPiiMasks(ocrFields)
    stageTimingsMs.piiDetect = Date.now() - piiDetectStart
    landlordNameFromOcr = landlordName

    // 실제 계약서에서 마스킹이 잘 되고 있는지 추적하기 위한 로그. 개수·유형만 남기고, 읽은 텍스트나
    // 이름 같은 실제 값은 절대 포함하지 않는다 — stats는 숫자 필드로만 이뤄져 있다(piiMask.ts 참고).
    console.log('PII mask summary', JSON.stringify(stats))

    let maskedImageBase64: string
    try {
      const t0 = Date.now()
      const maskedBytes = await applyBlackBoxes(workingImageBytes, boxes)
      // bytesToBase64도 이 구간에 포함시킨다 — 예전엔 imageEdit 측정이 끝난 다음 줄에서 호출돼
      // 어느 stageTimingsMs 항목에도 안 잡히고 있었다(이미지 크기에 비례하는 순수 CPU 연산인데도).
      maskedImageBase64 = bytesToBase64(maskedBytes)
      stageTimingsMs.imageEdit = Date.now() - t0
    } catch (err) {
      console.error(
        `PII masking failed, blocking analysis (refusing to send an unmasked image) — had ${stats.totalFields} OCR fields, ${stats.maskedFields} flagged for masking`,
        err,
      )
      return jsonResponse({ error: PII_MASK_FAILURE_MESSAGE }, 422)
    }

    // 원본은 여기서 끝 — 마스킹된 버전으로 교체하고 원본 base64는 더 이상 참조하지 않는다.
    // 애초에 어디에도 저장하지 않으므로(요청 처리 후 응답과 함께 폐기) 별도 삭제 로직은 불필요.
    input.fileBase64 = maskedImageBase64
    input.fileMimeType = 'image/png'
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const riskPatterns = await fetchAllRiskPatterns(supabaseAdmin)

  const patternFilterStart = Date.now()
  const patternFilter = filterRiskPatternsByKeywords(riskPatterns, ocrTextForPatternMatch)
  stageTimingsMs.patternFilter = Date.now() - patternFilterStart

  console.log(
    'Risk pattern filter',
    JSON.stringify({
      totalPatterns: riskPatterns.length,
      matchedPatterns: patternFilter.matched.length,
      matchedIds: patternFilter.matchedIds,
      fellBackToAll: patternFilter.fellBackToAll,
    }),
  )

  const referenceKnowledge = formatRiskPatterns(patternFilter.matched)

  // 프롬프트에 실제로 들어간 패턴(patternFilter.matched, 폴백으로 20건 전체인 경우도 포함)에만
  // 연결된 법 조항을 가져온다 — 20개 패턴 전체가 아니라 이미 걸러진 소수 기준이라 가볍다.
  const legalProvisionsStart = Date.now()
  const legalProvisions = await fetchLegalProvisionsForPatterns(supabaseAdmin, patternFilter.matchedIds)
  stageTimingsMs.legalProvisions = Date.now() - legalProvisionsStart

  console.log(
    'Legal provisions for prompt',
    JSON.stringify({ count: legalProvisions.length, ids: legalProvisions.map((p) => p.id) }),
  )

  const legalProvisionsKnowledge = formatLegalProvisions(legalProvisions)
  const legalProvisionById = new Map(legalProvisions.map((p) => [p.id, p]))

  const prompt = buildPrompt(input, referenceKnowledge, legalProvisionsKnowledge)
  const image = input.fileBase64 && input.fileMimeType ? { mimeType: input.fileMimeType, base64: input.fileBase64 } : undefined

  const startedAt = Date.now()

  // 성공/실패 어느 경로로 끝나든 같은 모양의 로그 한 줄을 남긴다 — Gemini가 실패하는 요청이야말로
  // 어느 단계가 오래 걸렸는지(특히 gemini 필드) 봐야 하는 경우인데, 예전엔 성공 경로에서만
  // 찍혀서 실패 시 아무 것도 안 남았다.
  const timingSummary = () => ({
    ...stageTimingsMs,
    total: Date.now() - startedAt,
    matchedPatternCount: patternFilter.matched.length,
    totalPatternCount: riskPatterns.length,
  })

  try {
    // Gemini 호출과 전세가율 계산(국토부 실거래가 DB 조회)은 서로 무관하므로 병렬로 실행한다.
    // AI 호출 소요시간은 이 병렬 블록 전체가 아니라 callVisionModel 자기 자신의 시작~끝만
    // 재도록 별도로 잰다(전세가율 계산이 더 오래 걸려도 Gemini 시간에 섞이지 않게).
    const geminiCallStart = Date.now()
    const [{ ok, status, text }, jeonseRatioCategory] = await Promise.all([
      callVisionModel({
        prompt,
        image,
        schema: ANALYSIS_RESPONSE_SCHEMA,
        schemaName: 'contract_analysis',
        timeoutMs: 28000,
      }).then((res) => {
        stageTimingsMs.gemini = Date.now() - geminiCallStart
        return res
      }),
      computeJeonseRatioCategory(supabaseAdmin, input),
    ])

    if (!ok) {
      console.error(`AI API error ${status} after retries (${Date.now() - startedAt}ms)`)
      console.log('analyze-contract stage timings (ms)', JSON.stringify(timingSummary()))
      return jsonResponse({ error: 'AI 분석 요청에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 502)
    }

    if (!text) {
      return jsonResponse({ error: 'AI로부터 응답을 받지 못했습니다.' }, 502)
    }

    const geminiResult = JSON.parse(text)

    // Gemini의 3개 카테고리 + 서버가 계산한 전세가율 카테고리를 합쳐 종합 점수를 가중평균으로
    // 계산한다(_shared/contractScore.ts). hugLandlordCheck.isBlacklisted가 true면 계산 결과가
    // 낮게 나와도 danger 하한으로 끌어올린다.
    const categories = [...coerceGeminiCategories(geminiResult.categories), jeonseRatioCategory]
    const scoreCalcStart = Date.now()
    const { overallScore, riskLevel, breakdown } = calculateOverallScore(
      categories,
      geminiResult.hugLandlordCheck?.isBlacklisted === true,
    )
    stageTimingsMs.scoreCalc = Date.now() - scoreCalcStart

    const result = {
      overallScore,
      riskLevel,
      // 점수 계산 근거(어떤 항목이 몇 %로 반영됐는지)를 화면에 보여주기 위한 값.
      scoreBreakdown: breakdown,
      // 새로 저장/반환되는 분석은 전부 "높을수록 위험" 기준이다. 과거(낮을수록 위험) 데이터와
      // 구분하기 위해 명시적으로 표시한다 — src/pages/Analysis.tsx가 이 값을 보고 legacy 데이터면
      // 다른 안내를 보여준다.
      scoreDirection: 'high_is_risky' as const,
      categories: categories.map((c) => ({
        name: c.name,
        score: c.score,
        level: c.score != null ? scoreToRiskLevel(c.score) : null,
        comment: c.comment,
      })),
      detectedClauses: resolveDetectedClauses(geminiResult.detectedClauses, legalProvisionById),
      recommendedActions: geminiResult.recommendedActions ?? [],
      aiComment: geminiResult.aiComment ?? '',
      hugLandlordCheck: geminiResult.hugLandlordCheck,
      // Gemini 응답에는 landlordName이 없다(마스킹된 이미지만 봤으므로) — OCR로 읽은 값을 주입한다.
      landlordName: landlordNameFromOcr,
    } as Record<string, unknown>

    // 임대인 이름이 확인됐다면 HUG 상습채무불이행자 명단과 trigram 유사도로 "사실 대조"한다.
    // 위의 hugLandlordCheck(AI 패턴 추정)와는 별개로, 이쪽이 실제 명단 기반이라 신뢰도가 더 높다.
    if (landlordNameFromOcr.trim()) {
      const { data: nameMatches, error: nameMatchError } = await supabaseAdmin.rpc(
        'search_hug_defaulters_by_name',
        { query_name: landlordNameFromOcr.trim() },
      )
      if (nameMatchError) {
        console.error('search_hug_defaulters_by_name failed, continuing without match info', nameMatchError)
      } else {
        const matches = (nameMatches ?? []) as HugDefaulterMatch[]
        result.hugDefaulterMatch = { matched: matches.length > 0, matches }
      }
    }

    const userId = await resolveUserId(req)
    const { error: insertError } = await supabaseAdmin.from('analyses').insert({
      user_id: userId,
      address: input.address || null,
      deposit: input.deposit || null,
      building_type: input.buildingType || null,
      overall_score: overallScore,
      risk_level: riskLevel,
      score_direction: 'high_is_risky',
      categories: result.categories,
      detected_clauses: result.detectedClauses,
      recommended_actions: result.recommendedActions,
      ai_comment: result.aiComment,
    })

    if (insertError) {
      // Don't fail the user-facing analysis just because the history log failed to save.
      console.error('analyses insert error', insertError)
    }

    console.log('analyze-contract stage timings (ms)', JSON.stringify(timingSummary()))

    return jsonResponse(result)
  } catch (err) {
    console.error(`analyze-contract error after ${Date.now() - startedAt}ms`, err)
    console.log('analyze-contract stage timings (ms)', JSON.stringify(timingSummary()))
    if (err instanceof Error && err.name === 'AbortError') {
      return jsonResponse({ error: 'AI 분석 요청이 시간 초과됐습니다. 잠시 후 다시 시도해주세요.' }, 502)
    }
    return jsonResponse({ error: '분석 중 오류가 발생했습니다.' }, 500)
  }
})
