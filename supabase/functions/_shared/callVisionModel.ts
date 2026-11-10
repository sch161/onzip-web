// 멀티모달(텍스트 + 이미지 1장) AI 호출 공통 래퍼. AI_PROVIDER=openai|gemini 로 분기하며,
// 기본값(미설정/알 수 없는 값)은 gemini다 — 기존 동작을 그대로 유지하기 위해서다.
// analyze-contract, analyze-chat 두 함수가 함께 쓴다. 응답은 항상 "스키마에 맞는 JSON 문자열"
// 하나(text)로 돌려주고, 파싱·후처리는 호출한 함수가 기존처럼 한다.
//
// OpenAI는 SDK 없이 fetch로 Responses API(v1/responses)를 호출한다(공식 문서가 신규 프로젝트에
// Responses를 권장). service_tier·fast·batch·flex·지역 처리 옵션은 일부러 설정하지 않아 Standard로
// 호출된다. 이미지·프롬프트 내용은 로그에 남기지 않는다.

export type AiProvider = 'gemini' | 'openai'

export interface VisionCallInput {
  prompt: string
  image?: { mimeType: string; base64: string }
  /** Gemini 방언 스키마(대문자 type, nullable). OpenAI 경로에서는 strict json_schema로 변환해 보낸다. */
  schema: Record<string, unknown>
  /** OpenAI json_schema의 name(영문/숫자/_ 만). */
  schemaName: string
  /** Gemini 경로의 요청당 타임아웃. OpenAI 경로는 OPENAI_TIMEOUT_MS를 쓴다. */
  timeoutMs?: number
}

export interface VisionCallOutput {
  ok: boolean
  status: number
  /** ok일 때 스키마에 맞는 JSON 문자열. 모델이 빈 응답을 줬으면 undefined. */
  text?: string
}

// ── 설정 ────────────────────────────────────────────────────────────────────────

// 재시도 횟수·타임아웃은 여기서 바꾼다.
const OPENAI_TIMEOUT_MS = 28000
const OPENAI_MAX_RETRIES = 1
const OPENAI_RETRY_DELAY_MS = 1000
/** 추론 토큰 + 출력 토큰 합계 상한. 걸려서 응답이 잘리면(incomplete) 에러로 처리한다. */
const OPENAI_MAX_OUTPUT_TOKENS = 8000

const OPENAI_DEFAULT_MODEL = 'gpt-6.1-sol'
const OPENAI_DEFAULT_EFFORT = 'low'
const OPENAI_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const OPENAI_RETRYABLE_STATUSES = new Set([429, 503])

const GEMINI_RETRYABLE_STATUSES = new Set([429, 503])
const GEMINI_RETRY_DELAYS_MS = [1000, 3000]
const DEFAULT_GEMINI_TIMEOUT_MS = 28000

export function getAiProvider(): AiProvider {
  const raw = Deno.env.get('AI_PROVIDER')?.trim().toLowerCase()
  if (!raw || raw === 'gemini') return 'gemini'
  if (raw === 'openai') return 'openai'
  console.warn(`Unknown AI_PROVIDER "${raw}", falling back to gemini`)
  return 'gemini'
}

/** 현재 provider의 API 키가 설정돼 있는지. 값 자체는 어디에도 출력하지 않는다. */
export function isVisionProviderConfigured(): boolean {
  return getAiProvider() === 'openai' ? Boolean(Deno.env.get('OPENAI_API_KEY')) : Boolean(Deno.env.get('GEMINI_API_KEY'))
}

export function missingKeyName(): string {
  return getAiProvider() === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'
}

export async function callVisionModel(input: VisionCallInput): Promise<VisionCallOutput> {
  return getAiProvider() === 'openai' ? await callOpenAi(input) : await callGemini(input)
}

// ── Gemini (기존 동작 그대로) ───────────────────────────────────────────────────

// Pinned model versions keep getting retired/restricted (2.0-flash, then 2.5-flash for new
// accounts) — "-latest" is a Google-managed alias that stays current automatically.
const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest'

/** Gemini generateContent 호출. 429/503 에러 응답뿐 아니라 응답 자체가 늦어져 타임아웃(AbortError)
 *  나는 경우도 지수 백오프(1초, 3초)로 최대 2회 더 재시도한다. 마지막 시도까지 타임아웃이면
 *  AbortError를 그대로 던지고(호출자가 "시간 초과" 메시지 처리), 마지막 시도까지 429/503이면
 *  그 응답을 그대로 반환한다(호출자가 사용자 에러 처리). */
async function callGemini(input: VisionCallInput): Promise<VisionCallOutput> {
  const apiKey = Deno.env.get('GEMINI_API_KEY')
  const model = Deno.env.get('GEMINI_MODEL') ?? GEMINI_DEFAULT_MODEL
  const timeoutMs = input.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS

  const parts: Record<string, unknown>[] = [{ text: input.prompt }]
  if (input.image) {
    parts.push({ inline_data: { mime_type: input.image.mimeType, data: input.image.base64 } })
  }
  const requestBody = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: input.schema,
    },
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= GEMINI_RETRY_DELAYS_MS.length
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      if (!isTimeout || isLastAttempt) throw err
      const delayMs = GEMINI_RETRY_DELAYS_MS[attempt]
      console.error(`Gemini API timed out after ${timeoutMs}ms, retrying in ${delayMs}ms (attempt ${attempt + 2}/${GEMINI_RETRY_DELAYS_MS.length + 1})`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      continue
    }
    clearTimeout(timer)

    if (res.ok || !GEMINI_RETRYABLE_STATUSES.has(res.status) || isLastAttempt) {
      const bodyText = await res.text()
      if (!res.ok) {
        console.error(`Gemini API error ${res.status} after retries`, bodyText.slice(0, 500))
        return { ok: false, status: res.status }
      }
      const geminiJson = JSON.parse(bodyText)
      const text: string | undefined = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) console.error('Empty Gemini response', JSON.stringify(geminiJson).slice(0, 500))
      return { ok: true, status: res.status, text }
    }

    const delayMs = GEMINI_RETRY_DELAYS_MS[attempt]
    console.error(`Gemini API ${res.status}, retrying in ${delayMs}ms (attempt ${attempt + 2}/${GEMINI_RETRY_DELAYS_MS.length + 1})`)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}

// ── OpenAI (Responses API) ──────────────────────────────────────────────────────

/** Gemini 방언 스키마를 OpenAI strict json_schema 규칙에 맞게 변환한다. 필드 의미는 바꾸지 않는다.
 *  - type 소문자화(OBJECT -> object, INTEGER -> integer ...)
 *  - 모든 object: additionalProperties:false, 모든 속성을 required로 올림
 *  - nullable:true 이거나 원래 required가 아니던 속성은 ["타입","null"] 유니온으로 표현
 *    (strict 모드는 optional을 지원하지 않아 null 유니온으로 흉내 내라고 안내한다) */
export function toStrictSchema(node: unknown, forceNullable = false): Record<string, unknown> {
  const src = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const type = typeof src.type === 'string' ? src.type.toLowerCase() : undefined
  const nullable = forceNullable || src.nullable === true

  if (src.description !== undefined) out.description = src.description

  if (type === 'object') {
    const props = (src.properties ?? {}) as Record<string, unknown>
    const required = new Set((src.required as string[] | undefined) ?? [])
    const outProps: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(props)) {
      outProps[key] = toStrictSchema(child, !required.has(key))
    }
    out.type = nullable ? ['object', 'null'] : 'object'
    out.properties = outProps
    out.required = Object.keys(outProps)
    out.additionalProperties = false
  } else if (type === 'array') {
    out.type = nullable ? ['array', 'null'] : 'array'
    out.items = toStrictSchema(src.items)
  } else {
    out.type = nullable ? [type, 'null'] : type
    if (Array.isArray(src.enum)) out.enum = nullable ? [...src.enum, null] : [...src.enum]
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickOpenAiEffort(): string {
  const raw = Deno.env.get('OPENAI_REASONING_EFFORT')?.trim().toLowerCase()
  return raw && OPENAI_EFFORTS.has(raw) ? raw : OPENAI_DEFAULT_EFFORT
}

/** OpenAI Responses API 호출. 429/503과 타임아웃은 OPENAI_MAX_RETRIES 만큼 재시도한다. 마지막 시도까지
 *  타임아웃이면 AbortError를 그대로 던진다(호출자가 "시간 초과" 메시지 처리 — Gemini 경로와 같다). */
async function callOpenAi(input: VisionCallInput): Promise<VisionCallOutput> {
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  const model = Deno.env.get('OPENAI_MODEL') ?? OPENAI_DEFAULT_MODEL
  const effort = pickOpenAiEffort()

  const content: Record<string, unknown>[] = [{ type: 'input_text', text: input.prompt }]
  if (input.image) {
    content.push({
      type: 'input_image',
      image_url: `data:${input.image.mimeType};base64,${input.image.base64}`,
      detail: 'auto',
    })
  }
  const requestBody = JSON.stringify({
    model,
    input: [{ role: 'user', content }],
    text: {
      format: { type: 'json_schema', name: input.schemaName, strict: true, schema: toStrictSchema(input.schema) },
    },
    reasoning: { effort },
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    // Responses API는 기본적으로 응답을 OpenAI 쪽에 저장한다. 계약서/대화 내용이 남지 않도록 끈다.
    store: false,
  })

  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= OPENAI_MAX_RETRIES
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: requestBody,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      if (!isTimeout || isLastAttempt) throw err
      console.error(`OpenAI API timed out after ${OPENAI_TIMEOUT_MS}ms, retrying in ${OPENAI_RETRY_DELAY_MS}ms (attempt ${attempt + 2}/${OPENAI_MAX_RETRIES + 1})`)
      await sleep(OPENAI_RETRY_DELAY_MS)
      continue
    }
    clearTimeout(timer)

    if (!res.ok && OPENAI_RETRYABLE_STATUSES.has(res.status) && !isLastAttempt) {
      await res.body?.cancel()
      console.error(`OpenAI API ${res.status}, retrying in ${OPENAI_RETRY_DELAY_MS}ms (attempt ${attempt + 2}/${OPENAI_MAX_RETRIES + 1})`)
      await sleep(OPENAI_RETRY_DELAY_MS)
      continue
    }

    const bodyText = await res.text()
    let json: Record<string, any> = {}
    try {
      json = JSON.parse(bodyText)
    } catch {
      // 본문이 JSON이 아니면 아래 !ok / 빈 응답 경로에서 처리한다.
    }

    if (!res.ok) {
      // 오류 본문 전체를 남기지 않고 type/code/message만 남긴다(요청 내용이 섞여 들어올 수 있어서).
      const e = json.error ?? {}
      console.error(`OpenAI API error ${res.status} after retries (${Date.now() - startedAt}ms)`, JSON.stringify({ type: e.type, code: e.code, message: e.message }).slice(0, 500))
      return { ok: false, status: res.status }
    }

    const usage = json.usage ?? {}
    console.log(
      '[openai] usage',
      JSON.stringify({
        model: json.model ?? model,
        effort,
        status: json.status,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
        cached_tokens: usage.input_tokens_details?.cached_tokens,
        ms: Date.now() - startedAt,
      }),
    )

    // 토큰 상한에 걸려 잘린 응답은 JSON이 깨져 있을 수 있으므로 에러로 처리한다.
    if (json.status === 'incomplete') {
      console.error(`OpenAI response incomplete: ${json.incomplete_details?.reason ?? 'unknown'}`)
      return { ok: false, status: 502 }
    }
    if (json.status === 'failed') {
      console.error('OpenAI response failed', JSON.stringify({ code: json.error?.code, message: json.error?.message }).slice(0, 500))
      return { ok: false, status: 502 }
    }

    let text: string | undefined
    for (const item of (json.output ?? []) as Record<string, any>[]) {
      if (item.type !== 'message') continue
      for (const part of (item.content ?? []) as Record<string, any>[]) {
        if (part.type === 'refusal') {
          console.error('OpenAI refused the request')
          return { ok: false, status: 502 }
        }
        if (part.type === 'output_text' && typeof part.text === 'string') text = (text ?? '') + part.text
      }
    }
    if (!text) console.error('Empty OpenAI response', JSON.stringify({ status: json.status, outputTypes: (json.output ?? []).map((o: any) => o.type) }))
    return { ok: true, status: res.status, text }
  }
}
