// scripts/check-ai-functions.mjs
// analyze-contract / analyze-chat 두 Edge Function이 응답하는지, 응답 JSON 구조가 어떤지 확인한다.
// Gemini 경로(배포 직후 확인)와 OpenAI 경로(AI_PROVIDER 전환 후)가 "같은 필드 구조"를 내는지
// 비교하는 용도다. 키는 환경변수로만 받는다(.env 파일은 읽지 않는다).
//
// 주의: 익명 호출도 분석 기록을 남긴다(analyses / gaslighting_checks 에 user_id=null 행 1건씩).
//   테스트 행은 주소 "[ai-check] ..." / 입력 "[ai-check] ..."로 시작하니 필요하면 나중에 지우면 된다.
//   또 실제 AI 호출이 발생하므로 비용이 든다(함수당 1회). 이미지는 보내지 않는다(텍스트/주소만).
//
// 필요 env:
//   SUPABASE_ANON_KEY   (필수) 프로젝트의 anon/publishable 키
//   SUPABASE_URL        (선택) 기본값: https://yksrvkofbxordjagazzi.supabase.co
//
// 실행 예:
//   1) 배포 직후 Gemini 경로 확인 + 구조 저장
//        node scripts/check-ai-functions.mjs --save shape-gemini.json
//   2) AI_PROVIDER=openai 로 바꾼 뒤 같은 입력으로 구조 비교
//        node scripts/check-ai-functions.mjs --against shape-gemini.json
//   3) 로컬 serve 확인(--base 로 주소 지정):
//        node scripts/check-ai-functions.mjs --base http://127.0.0.1:54321/functions/v1
//   옵션: --only chat | contract

const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PROJECT_URL = (process.env.SUPABASE_URL ?? "https://yksrvkofbxordjagazzi.supabase.co").replace(/\/$/, "");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (flag("--base") ?? `${PROJECT_URL}/functions/v1`).replace(/\/$/, "");
const savePath = flag("--save");
const againstPath = flag("--against");
const only = flag("--only");

if (!ANON_KEY) {
  console.error("SUPABASE_ANON_KEY 환경변수가 필요합니다.");
  process.exit(2);
}

const CASES = {
  chat: {
    path: "analyze-chat",
    body: {
      message:
        "[ai-check] 지금 계약 안 하시면 다른 분이 바로 계약하세요. 등기부는 제가 확인했으니 믿으시고 오늘 안에 가계약금 먼저 보내주세요.",
    },
    // 프론트가 기대하는 최상위 필드(src/lib/analyzeChat.ts 응답 타입 기준)
    requiredTop: ["riskLevel", "confidence", "patterns", "isWarning", "aiReply", "suggestedResponse"],
  },
  contract: {
    path: "analyze-contract",
    body: { address: "[ai-check] 서울특별시 마포구 월드컵로 1", deposit: "2억 원", buildingType: "빌라" },
    requiredTop: ["overallScore", "riskLevel", "categories", "detectedClauses", "recommendedActions", "aiComment", "hugLandlordCheck"],
  },
};

/** 값의 "구조"만 뽑는다. 배열은 모든 원소의 구조를 합쳐서(키 합집합) 하나로 본다. */
function shapeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return ["empty"];
    return [v.map(shapeOf).reduce(mergeShape)];
  }
  if (typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k])]));
  }
  return typeof v;
}

function mergeShape(a, b) {
  if (a === b) return a;
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out[k] = k in a && k in b ? mergeShape(a[k], b[k]) : (a[k] ?? b[k]);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a[0] === "empty") return b;
    if (b[0] === "empty") return a;
    return [mergeShape(a[0], b[0])];
  }
  return a === b ? a : `${a}|${b}`;
}

/** 두 구조의 차이를 경로 문자열로 나열한다. */
function diffShape(a, b, path = "$") {
  const out = [];
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push(`+ ${path}.${k} (비교 대상에만 있음)`);
      else if (!(k in b)) out.push(`- ${path}.${k} (기준에만 있음)`);
      else out.push(...diffShape(a[k], b[k], `${path}.${k}`));
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a[0] !== "empty" && b[0] !== "empty") out.push(...diffShape(a[0], b[0], `${path}[]`));
  } else if (a !== b) {
    // "null|number" 같은 값 의존 유니온은 한쪽이라도 겹치는 타입이 있으면 같은 것으로 본다.
    const sa = typeof a === "string" ? a.split("|") : [JSON.stringify(a)];
    const sb = typeof b === "string" ? b.split("|") : [JSON.stringify(b)];
    if (!sa.some((t) => sb.includes(t))) out.push(`~ ${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  return out;
}

async function callFunction(name, c) {
  const startedAt = Date.now();
  const res = await fetch(`${base}/${c.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify(c.body),
  });
  const ms = Date.now() - startedAt;
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 본문이 JSON이 아니면 그대로 실패 처리(본문 앞부분만 출력)
  }
  return { name, status: res.status, ms, json, raw: text.slice(0, 200) };
}

const names = Object.keys(CASES).filter((n) => !only || n === only);
const against = againstPath ? JSON.parse((await import("node:fs")).readFileSync(againstPath, "utf8")) : undefined;
const shapes = {};
let failed = false;

for (const name of names) {
  const c = CASES[name];
  let r;
  try {
    r = await callFunction(name, c);
  } catch (err) {
    console.error(`[${name}] 요청 실패: ${err.message}`);
    failed = true;
    continue;
  }
  if (r.status !== 200 || !r.json) {
    console.error(`[${name}] HTTP ${r.status} (${r.ms}ms) — ${r.json?.error ?? r.raw}`);
    failed = true;
    continue;
  }
  const missing = c.requiredTop.filter((k) => !(k in r.json));
  shapes[name] = shapeOf(r.json);
  console.log(`[${name}] HTTP 200 (${r.ms}ms) 최상위 필드: ${Object.keys(r.json).sort().join(", ")}`);
  if (missing.length) {
    console.error(`[${name}] 필수 필드 누락: ${missing.join(", ")}`);
    failed = true;
  }
  if (against?.[name]) {
    const diffs = diffShape(against[name], shapes[name]);
    if (diffs.length) {
      console.error(`[${name}] 기준 대비 구조 차이 ${diffs.length}건:\n  ${diffs.join("\n  ")}`);
      failed = true;
    } else {
      console.log(`[${name}] 기준과 필드 구조 동일`);
    }
  } else if (againstPath) {
    console.warn(`[${name}] 기준 파일에 이 함수의 구조가 없어 비교를 건너뜀`);
  }
}

if (savePath && !failed) {
  (await import("node:fs")).writeFileSync(savePath, JSON.stringify(shapes, null, 2));
  console.log(`구조를 ${savePath} 에 저장했습니다.`);
}

process.exit(failed ? 1 : 0);
