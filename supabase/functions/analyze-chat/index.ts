// Supabase Edge Function: analyze-chat
// Calls Gemini to detect "가스라이팅" (psychological manipulation) risk in a
// message sent by a real-estate agent/landlord. Same pattern as analyze-contract:
// the Gemini API key is read from Supabase Secrets (Deno.env) and never reaches the client.
// Each analysis is also persisted to `gaslighting_checks` via a service_role client.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { analyzePsychGuard, type PsychGuardGrade, type PsychGuardResult } from '../_shared/psychGuard.ts'
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

interface AnalyzeChatRequest {
  /** 부동산 중개인/집주인이 보낸 문자 메시지 원문 (텍스트 또는 이미지 중 최소 하나는 필요) */
  message?: string
  /** 카카오톡/문자 캡처 이미지, base64 인코딩, no data: prefix */
  fileBase64?: string
  fileMimeType?: string
}

const RISK_LEVELS = ['위험', '주의', '안전'] as const
const PATTERN_LABELS = ['재촉', '허위정보 주입', '신뢰 유도'] as const

// 규칙 기반 심리 가드(analyzePsychGuard)의 등급 -> 기존 Gemini 응답 스키마의 riskLevel 매핑.
const PSYCH_GUARD_GRADE_TO_RISK_LEVEL: Record<PsychGuardGrade, (typeof RISK_LEVELS)[number]> = {
  danger: '위험',
  caution: '주의',
  safe: '안전',
}

const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    riskLevel: { type: 'STRING', enum: RISK_LEVELS, description: '가스라이팅 위험도 등급' },
    confidence: { type: 'INTEGER', description: '판단에 대한 확신도 0~100' },
    patterns: {
      type: 'ARRAY',
      description: '재촉, 허위정보 주입, 신뢰 유도 3가지 패턴 각각에 대한 탐지 점수',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING', enum: PATTERN_LABELS },
          score: { type: 'INTEGER', description: '해당 패턴이 감지된 정도 0~100' },
        },
        required: ['label', 'score'],
      },
    },
    isWarning: { type: 'BOOLEAN', description: '사용자에게 경고 배너를 띄워야 하는지 여부' },
    aiReply: { type: 'STRING', description: '챗봇이 사용자에게 보여줄 분석 답변 (친절한 한국어)' },
    suggestedResponse: { type: 'STRING', description: '사용자가 복사해서 상대방에게 바로 보낼 수 있는 대응 멘트' },
  },
  required: ['riskLevel', 'confidence', 'patterns', 'isWarning', 'aiReply', 'suggestedResponse'],
}

function buildPrompt(message: string | undefined, hasImage: boolean): string {
  const messageSection =
    message && hasImage
      ? `받은 메시지(텍스트):\n"""\n${message}\n"""\n또한 카카오톡/문자 캡처 이미지가 첨부되어 있습니다. 이미지 속 대화 내용도 함께 읽고 분석하세요.`
      : hasImage
        ? `첨부된 카카오톡/문자 캡처 이미지 속 대화 내용을 직접 읽고(OCR) 분석하세요. 이미지에 여러 메시지가 있다면 상대방(중개인/집주인)이 보낸 메시지를 중심으로 분석하세요.`
        : `받은 메시지:\n"""\n${message}\n"""`

  return `당신은 부동산 거래 과정에서 발생하는 "가스라이팅"(심리적 조작)을 탐지하는 전문 AI입니다.
세입자가 부동산 중개인 또는 집주인으로부터 받은 아래 메시지를 분석하세요.

${messageSection}

지침:
1. 아래 3가지 조작 패턴 각각에 대해 이 메시지에서 얼마나 강하게 드러나는지 0~100점으로 평가하세요. 해당되지 않으면 0점을 주세요.
   - 재촉: "지금 아니면 안 된다", "다른 사람도 보고 있다" 등 즉각적인 결정을 강요하는 패턴
   - 허위정보 주입: 사실과 다르거나 확인되지 않은 정보로 세입자를 오도하려는 패턴
   - 신뢰 유도: 근거 없이 "저를 믿으세요", "제가 알아서 할게요" 등으로 확인 절차를 건너뛰게 만드는 패턴
2. confidence는 이 판단에 대한 AI의 확신도입니다.
3. riskLevel은 종합적인 위험도이며, 위험(적극적 조작 정황) / 주의(의심 정황) / 안전(정상적인 안내) 중 하나입니다.
4. isWarning은 riskLevel이 "위험"이거나 조작 패턴 점수가 뚜렷하게 높을 때 true로 설정하세요.
5. aiReply에는 사용자에게 상황을 설명하는 공감 어린 한국어 답변을 2~4문장으로 작성하세요.
6. suggestedResponse에는 사용자가 그대로 복사해서 상대방에게 보낼 수 있는, 정중하지만 단호하게 확인을 요구하는 문자 멘트를 작성하세요.
7. 반드시 지정된 JSON 스키마 형식으로만 응답하세요.`
}

interface GeminiResult {
  riskLevel: (typeof RISK_LEVELS)[number]
  confidence: number
  patterns: { label: string; score: number }[]
  isWarning: boolean
  aiReply: string
  suggestedResponse: string
}

// Gemini/OpenAI 호출·재시도 로직은 _shared/callVisionModel.ts로 옮겼다(기존 Gemini 재시도 동작 그대로).

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

  let input: AnalyzeChatRequest
  try {
    input = await req.json()
  } catch {
    return jsonResponse({ error: '요청 형식이 올바르지 않습니다.' }, 400)
  }

  const message = input.message?.trim()
  const hasImage = Boolean(input.fileBase64 && input.fileMimeType)
  if (!message && !hasImage) {
    return jsonResponse({ error: '분석할 문자 내용 또는 캡처 이미지를 입력해주세요.' }, 400)
  }

  const prompt = buildPrompt(message, hasImage)
  const image = hasImage ? { mimeType: input.fileMimeType!, base64: input.fileBase64! } : undefined

  const startedAt = Date.now()

  try {
    const { ok, status, text } = await callVisionModel({
      prompt,
      image,
      schema: ANALYSIS_RESPONSE_SCHEMA,
      schemaName: 'chat_analysis',
      timeoutMs: 28000,
    })

    if (!ok) {
      console.error(`AI API error ${status} after retries (${Date.now() - startedAt}ms)`)
      return jsonResponse({ error: 'AI 분석 요청에 실패했습니다. 잠시 후 다시 시도해주세요.' }, 502)
    }

    if (!text) {
      return jsonResponse({ error: 'AI로부터 응답을 받지 못했습니다.' }, 502)
    }

    const result: GeminiResult = JSON.parse(text)

    // Gemini의 "가스라이팅 여부" 자체 판단은 주관적이라 신뢰도가 낮다 — 규칙 기반
    // analyzePsychGuard()로 최종 riskLevel/isWarning을 덮어써 판정 신뢰도를 높인다.
    // 이미지만 첨부되고 텍스트가 없는 경우엔 매칭할 텍스트가 없으므로 Gemini 판단을 그대로 둔다.
    let psychGuardResult: PsychGuardResult | null = null
    if (message) {
      psychGuardResult = analyzePsychGuard(message)
      result.riskLevel = PSYCH_GUARD_GRADE_TO_RISK_LEVEL[psychGuardResult.grade]
      result.isWarning = psychGuardResult.grade !== 'safe'
      console.log(
        `[analyze-chat] psychGuard grade=${psychGuardResult.grade} score=${psychGuardResult.totalScore} complex=${psychGuardResult.hasComplexPattern} (Gemini riskLevel 대체됨)`,
      )
    }

    const userId = await resolveUserId(req)
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { error: insertError } = await supabaseAdmin.from('gaslighting_checks').insert({
      user_id: userId,
      input_text: message || '(캡처 이미지 첨부)',
      risk_level: result.riskLevel,
      confidence: result.confidence,
      patterns: result.patterns,
      suggested_response: result.suggestedResponse,
    })

    if (insertError) {
      // Don't fail the user-facing analysis just because the history log failed to save.
      console.error('gaslighting_checks insert error', insertError)
    }

    return jsonResponse(result)
  } catch (err) {
    console.error(`analyze-chat error after ${Date.now() - startedAt}ms`, err)
    if (err instanceof Error && err.name === 'AbortError') {
      return jsonResponse({ error: 'AI 분석 요청이 시간 초과됐습니다. 잠시 후 다시 시도해주세요.' }, 502)
    }
    return jsonResponse({ error: '분석 중 오류가 발생했습니다.' }, 500)
  }
})
