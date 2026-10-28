# ONZIP 프로젝트 기술 문서

> 이 문서는 최초 2026-08-18 기준 코드베이스(`src/`, `supabase/functions/`, `supabase/migrations/`, `scripts/`, `.github/workflows/`)를 실제로 읽고 작성했고, 2026-08-21 변경분(계약서 PII 마스킹 파이프라인, 계약서 위험도 코드 계산 전환, 배치 상태판 관리자 전용화, 계정 전환 시 세션 데이터 정리)을 반영해 2026-08-22 갱신했습니다. 이후 2026-09-15(계약서 업로드 이미지 CPU 타임아웃 546 해결)·2026-09-18(심리 가드 판정을 Gemini 자체 판단에서 Cialdini 설득의 6원칙 기반 규칙 매칭으로 전환, HUG 크롤러 재시도/체크포인트 추가) 변경분도 반영했습니다. 계획만 있고 구현되지 않은 부분은 **[미구현]**으로, 구현은 됐지만 한계가 있는 부분은 솔직하게 표기했습니다. 멘토링에서 그대로 읽으면서 설명할 수 있도록 코드 인용보다 흐름 설명 위주로 작성했습니다. 계약서 PII 마스킹의 단계별 상세 흐름(어떤 데이터가 언제 외부로 나가는지 등)은 이 문서에서 중복 서술하지 않고 [`docs/PRIVACY_FLOW.md`](PRIVACY_FLOW.md)를 참고하도록 링크로 대신합니다(단, `PRIVACY_FLOW.md`의 이미지 리사이즈 상한 수치는 2026-08-21 기준 2000px로 남아 있어 2026-09-15 변경분인 1200px가 아직 반영되지 않았습니다 — 아래 7장 참고).

---

## 1. 전체 아키텍처 개요

### 1-1. 구성 요소

- **프론트엔드**: Vite + React 18 + TypeScript + Tailwind CSS. SPA(React Router)로 동작하며 별도 SSR/BFF 서버 없음. Vercel에 정적 배포(`vercel.json` 존재).
- **백엔드**: Supabase Edge Functions(Deno). 사용자 요청 시 실행되는 함수 2개(`analyze-contract`, `analyze-chat`, `delete-account`)와 pg_cron이 주기적으로 호출하는 배치 함수 3개(`fetch-market-data`, `fetch-region-buzz`, `sync-news`)로 구성.
- **데이터베이스**: Supabase Postgres. 8개 테이블 + Row Level Security(RLS) + `pg_trgm` 확장(트라이그램 유사도 검색) + `pg_cron`/`pg_net`(스케줄링·HTTP 호출) + Supabase Vault(시크릿 보관).
- **외부 API**: Google Gemini API(계약서/대화 분석), 네이버클라우드 CLOVA OCR(계약서 이미지의 개인정보 위치 검출 → 마스킹, 2026-08-21 추가), 네이버 뉴스 검색 API(뉴스·언급빈도), 국토교통부 실거래가 API(전세가율 산출용 원자료), 카카오맵 SDK(지도 렌더링), Google/Kakao OAuth(소셜 로그인).
- **오프-플랫폼 자동화**: GitHub Actions가 주 1회 Node 스크립트(`scripts/sync-hug-defaulters.mjs`)를 실행해 HUG 명단을 크롤링 — Supabase 생태계 밖에서 도는 유일한 자동화.

### 1-2. 텍스트 다이어그램

```
[브라우저 SPA: React]
   ├─ VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY  ──▶  Supabase Auth (이메일/Google/Kakao 로그인, JWT 세션)
   ├─ VITE_SUPABASE_ANON_KEY (anon key, RLS로 권한 제한) ──▶  Postgres (analyses, gaslighting_checks, region_stats, news 등 SELECT)
   ├─ supabase.functions.invoke('analyze-contract') ─┐
   ├─ supabase.functions.invoke('analyze-chat')      ─┼─▶  [Supabase Edge Functions, Deno]
   ├─ supabase.functions.invoke('delete-account')    ─┘        │  GEMINI_API_KEY, NAVER_*, MOLIT_API_KEY,
   └─ VITE_KAKAO_MAP_KEY ──▶ 카카오맵 SDK(dapi.kakao.com, 브라우저에서 직접 로드)  │  CLOVA_OCR_INVOKE_URL/SECRET_KEY
                                                                 │  (Supabase Secrets, 서버 전용)
                                                                 ▼
                    Google Gemini API / CLOVA OCR API / 네이버 뉴스 API / 국토교통부 실거래가 API
                                                                 │
                                                                 ▼
                                    service_role 클라이언트로 Postgres에 결과 저장 (RLS 우회)

   ※ analyze-contract는 이미지를 CLOVA OCR로 먼저 분석해 개인정보 위치를 찾아 검은 사각형으로
     마스킹한 뒤에만 Gemini로 보낸다(2026-08-21 추가). 이 단계별 데이터 흐름은 이 문서에서
     반복 서술하지 않고 PRIVACY_FLOW.md에 근거 라인 번호와 함께 정리돼 있다.

[pg_cron, Postgres 내부 스케줄러]
   ├─ fetch-market-data-batch (20분 간격, 1일 9회) ─▶ net.http_post(x-cron-secret) ─▶ fetch-market-data 함수 ─▶ MOLIT API ─▶ region_stats 갱신
   ├─ fetch-region-buzz-batch (20분 간격, 시장데이터 10분 뒤) ─▶ fetch-region-buzz 함수 ─▶ 네이버 뉴스 API ─▶ region_stats 갱신
   └─ sync-news (6시간 간격) ─▶ sync-news 함수 ─▶ 네이버 뉴스 API ─▶ news 테이블 갱신

[GitHub Actions, Supabase 밖]
   └─ 매주 월요일 05:00 KST ─▶ scripts/sync-hug-defaulters.mjs (SUPABASE_SERVICE_ROLE_KEY로 직접 접속)
         └─▶ HUG 안심전세포털 크롤링(cheerio) ─▶ hug_defaulters 테이블 upsert
```

### 1-3. 왜 이런 구조를 택했는가

**API 키를 서버(Edge Function)에만 두는 이유**는 브라우저 번들에 포함되는 모든 `VITE_` 접두사 환경변수는 최종 사용자에게 그대로 노출되기 때문입니다. Gemini/네이버/국토부 키가 프론트에 있으면 누구나 개발자 도구로 추출해 무단 사용·과금 유발이 가능합니다. 그래서:

- `GEMINI_API_KEY`, `NAVER_CLIENT_ID/SECRET`, `MOLIT_API_KEY`, `CLOVA_OCR_INVOKE_URL`/`CLOVA_OCR_SECRET_KEY`는 **Supabase Secrets**(Edge Function 런타임에만 주입되는 환경변수)에 두고, 프론트는 이 값들을 절대 참조하지 않습니다. 대신 프론트는 `supabase.functions.invoke(...)`로 Edge Function을 호출하고, 실제 외부 API 호출은 서버 쪽 코드가 대행합니다.
- `SUPABASE_SERVICE_ROLE_KEY`(RLS를 완전히 우회하는 최고 권한 키)는 GitHub Actions Secrets에만 존재하고, 리포지토리 코드 어디에도 값 자체가 없습니다. 이 키가 필요한 이유는 계약서/대화 분석 결과를 `analyses`/`gaslighting_checks`에 쓸 때, 그리고 HUG 명단을 `hug_defaulters`에 upsert할 때 RLS 정책(본인 데이터만 SELECT 가능)을 우회해 시스템이 대신 써야 하기 때문입니다.
- 반대로 **카카오맵 JavaScript 키**(`VITE_KAKAO_MAP_KEY`)는 프론트 환경변수로 관리합니다. 애초에 브라우저에서 직접 로드되는 것을 전제로 발급되는 키이고, 카카오 개발자 콘솔에서 도메인 화이트리스트로 오남용을 막는 구조이기 때문에 서버에 숨길 이유가 없습니다.
- 사용자 요청형 함수(`analyze-contract`, `analyze-chat`)는 `supabase/config.toml`에서 `verify_jwt = false`로 설정되어 있습니다. 이유는 프로젝트가 신규 형식의 publishable anon key(`sb_publishable_...`)를 쓰는데, 이는 JWT가 아니라서 비로그인 상태에서는 Authorization 헤더 자체가 안 실리기 때문입니다(`verify_jwt=true`면 비로그인 사용자의 모든 요청이 거부됨). 대신 함수 내부에서 `Authorization` 헤더가 있으면 파싱해 `user_id`를 선택적으로 채우고, 없으면 `user_id`를 `null`로 저장합니다 — 즉 **비로그인 상태에서도 분석 자체는 가능하지만 이력이 남지 않습니다.**
- 배치 함수(`fetch-market-data`, `fetch-region-buzz`)는 pg_cron/pg_net이 호출하는데, 이 경로는 Supabase가 서명한 JWT를 실을 수 없습니다. 그래서 별도의 `x-cron-secret` 헤더(값은 Supabase Vault에 저장된 `cron_secret`)를 자체 검증하는 방식(`_shared/cronAuth.ts`)으로 "이 요청은 pg_cron이 보낸 것이 맞다"를 확인합니다.

---

## 2. 화면(페이지)별 기능 목록

`src/pages/` 기준 실제 존재하는 페이지는 총 10개입니다. `MainLayout`(TopNav+BottomNav)으로 감싸이는 페이지는 `/home`, `/psych-guard`, `/map`, `/profile` 4개뿐이고, 나머지(`/`, `/login`, `/signup`, `/analysis`, `/psych-guard/:id`, `/privacy`, `/scoring`)는 레이아웃 밖에서 독립적으로 렌더링됩니다. 특히 `/analysis`는 성격상 "앱의 핵심 화면"인데도 `MainLayout` 밖에 있어서, `Analysis.tsx`가 자체적으로 `<TopNav variant="app"/>`를 다시 렌더링하고 `BottomNav`는 아예 없습니다 — 레이아웃 일관성 관점의 사소한 허점입니다.

| 라우트 | 파일 | 기능 | 데이터 소스 | 호출 함수 |
|---|---|---|---|---|
| `/`, `/login` | `Login.tsx` | 이메일 로그인, Google/Kakao 로그인 | Supabase Auth | `supabase.auth.signInWithPassword`, `supabase.auth.signInWithOAuth({provider:'google'\|'kakao'})` |
| `/signup` | `Signup.tsx` | 이메일 회원가입, 소셜 회원가입 | Supabase Auth | `supabase.auth.signUp` (name/region을 user_metadata에 저장), `signInWithOAuth` |
| `/home` | `Home.tsx` | 계약서 업로드 폼 + 최근 뉴스 목록 | `news` 테이블 | `analyzeContract()` → Edge Function `analyze-contract`, `fetchLatestNews(12)` |
| `/analysis` | `Analysis.tsx` | 계약서 분석 결과 표시 | `location.state` 또는 `sessionStorage`(`onzip:lastAnalysis`) | 없음(수신한 결과를 그대로 렌더링) |
| `/psych-guard` | `Cure.tsx` | 심리 가드(가스라이팅 탐지) 채팅 UI | `sessionStorage`(`onzip:psychGuardMessages`) | `analyzeChat()` → Edge Function `analyze-chat` |
| `/psych-guard/:id` | `GaslightingDetail.tsx` | 개별 대화 분석 결과 상세 | `gaslighting_checks` 테이블 | `fetchGaslightingCheckById(id)` |
| `/map` | `SignalMap.tsx` | 전국 시/군/구 위험도 지도 | `region_stats` 테이블 + `public/data/skorea-municipalities.json` | `fetchRegionStats()`, 카카오맵 SDK |
| `/profile` | `Profile.tsx` | 프로필, 분석 이력, 계정 관리, (관리자만 보이는) 배치 작업 상태판 | `analyses`, `gaslighting_checks`, `batch_job_status` 테이블 | `fetchAnalysisHistory()`, `fetchGaslightingHistory()`, `deleteAccount()`, `fetchBatchJobStatus()` |
| `/privacy` | `Privacy.tsx` | 개인정보 처리방침 안내 | 없음(정적 텍스트) | 없음 |
| `/scoring` | `ScoringGuide.tsx` (2026-08-21 추가) | 계약서 종합 점수·안심맵 지역 위험도 산정 기준(가중치·등급 경계) 안내 | 없음(정적 텍스트 — `_shared/contractScore.ts`/`_shared/riskScore.ts`의 값을 사람이 수동으로 옮겨 적어 코드 주석으로 "값을 맞춰야 한다"고 명시) | 없음 |

**인증 가드**: 라우트 레벨의 접근 제어 컴포넌트는 존재하지 않습니다. 로그인 여부와 무관하게 `Home`/`Cure`/`SignalMap`/`Analysis`는 렌더링되고, 실제로 로그아웃 상태에서 리다이렉트를 거는 화면은 **`Profile.tsx`가 유일**합니다(`useEffect`에서 `supabase.auth.getUser()` 확인 후 `!user`면 `/login`으로 이동).

---

## 3. 기능별 상세 데이터 흐름

### 3-1. 계약서 안전 스캔 (`/home` → `/analysis`)

**① 사용자 입력** — `Home.tsx`의 업로드 카드에서 주소(필수), 보증금(필수), 건물 유형(선택)을 입력하고, 계약서/등기부등본 이미지 또는 PDF를 파일 선택 또는 드래그 앤 드롭으로 첨부합니다. 화면에는 "최대 20MB, HWP는 PDF로 변환" 안내 문구가 있지만 **실제 파일 크기·타입 검증 코드는 존재하지 않습니다** — 안내는 텍스트일 뿐이고 무엇을 올려도 그대로 전송됩니다.

**② 처리 — PDF 변환 및 프론트 인코딩** — PDF를 선택한 경우 `convertPdfToImage()`(`src/lib/pdfToImage.ts`, 2026-08-21 추가)가 pdf.js로 각 페이지를 캔버스에 렌더링해 세로로 이어붙인 뒤 PNG `Blob` 하나로 변환합니다. 이 변환은 **전부 브라우저 안에서 끝나고 서버는 PDF 자체를 받지 않습니다**(Edge Function은 `image/jpeg`·`image/png`가 아니면 즉시 400). 이후 `analyzeContract()`(`src/lib/analyzeContract.ts`)가 (변환된 경우 이미지) 파일을 `arrayBuffer()`로 읽어 바이트 단위로 순회하며 `btoa()`로 base64 문자열을 만듭니다(청크 분할 없이 메인 스레드에서 동기 실행 — 큰 파일일수록 UI가 잠깐 멈출 수 있음). 이후 `{ address, deposit, buildingType, fileBase64, fileMimeType }`을 body로 `supabase.functions.invoke('analyze-contract')`를 호출합니다. 업로드는 별도 Storage 경유 없이 **파일 전체를 JSON 요청 본문에 base64로 실어 보내는 방식**입니다.

**③ 처리 — Edge Function `analyze-contract`**
1. `address` 또는 `fileBase64` 둘 중 하나는 필수(둘 다 없으면 400). `GEMINI_API_KEY` 미설정 시 500.
2. **개인정보 마스킹 (2026-08-21 추가)** — 첨부 파일이 있으면 Gemini를 호출하기 전에 CLOVA OCR로 텍스트·좌표를 읽어 주민등록번호·계좌번호·전화번호·임대인/임차인 성명·당사자 개인 주소를 찾아 검은 사각형으로 가리고, **마스킹된 이미지로 원본을 교체한 뒤에만** Gemini에 보냅니다. 이미지 정규화·OCR·마스킹 중 어느 단계든 실패하면 즉시 422 에러로 분석을 중단합니다(fail-safe — 원본이나 부분 마스킹본이 Gemini로 새어나가는 경우가 없도록). 임대인 성명은 OCR로 읽은 값을 서버 메모리에만 갖고 있다가 8번 단계(HUG 명단 조회)에만 쓰고 Gemini 요청에는 포함되지 않습니다. 이 파이프라인의 단계별 상세(정규식·라벨 매칭 로직, 각 단계에서 무엇이 외부로 나가는지, 발견·수정된 개인정보 문제 2건 등)는 [`docs/PRIVACY_FLOW.md`](../docs/PRIVACY_FLOW.md)에 근거 라인과 함께 정리돼 있습니다.
3. **"RAG" 단계 (2026-08-28 키워드 필터링 추가)** — `contract_risk_patterns`(전세사기·독소조항 실제 피해 패턴 DB, 20건)를 일단 `SELECT *`로 전부 가져오되, 프롬프트에는 **OCR로 이미 읽은 계약서 텍스트에 그 패턴의 핵심 키워드가 하나라도 등장하는 패턴만** 골라 넣습니다(`_shared/riskPatternFilter.ts`의 `filterRiskPatternsByKeywords`). 키워드는 자동 추출이 아니라 20건 실데이터를 직접 확인하고 사람이 고른 목록(`RISK_PATTERN_KEYWORDS`, pattern id → 키워드 배열)이라, 패턴이 추가·수정되면 이 목록도 같이 손봐야 합니다. **매칭이 0건이거나(OCR 텍스트에 키워드가 전혀 없음) 애초에 첨부 파일이 없어 OCR 텍스트 자체가 없으면 안전하게 20건 전체로 폴백**합니다 — 매칭 0건을 "정말 위험 없음"으로 속단하기보다, 근거 사례 없이 Gemini 혼자 판단하게 두는 쪽이 더 위험하다고 판단했기 때문입니다. 몇 건이 매칭됐는지는 매 요청마다 `Risk pattern filter` 로그 한 줄(`totalPatterns`/`matchedPatterns`/`matchedIds`/`fellBackToAll`)로 남습니다. 여전히 벡터 임베딩·전문검색(tsvector)이 아니라 단순 부분 문자열 매칭이라, 키워드 목록에 없는 표현으로 위험 신호가 있으면 놓칠 수 있습니다 — "테이블이 커지면 검색 기반으로 바꿀 것"이라는 원래 주석은 여전히 유효한 다음 단계입니다. 이 20건이 어디서 왔는지는 개별 패턴마다 판례를 인용한 것이 아니라, 경기도 전세피해지원센터 사례집·국토교통부/HUG 가이드북·한국공인중개사협회 체크리스트 3개 자료를 종합해 정리한 것이며(2026-08-26부터 `pattern_sources` 테이블에 데이터셋 전체 수준의 출처로 기록, `/scoring` 페이지에 노출), `/analysis`의 "AI 위험 패턴 감지" 배너에도 같은 안내가 표시됩니다.
4. **법 조항 연동 (2026-08-28 추가)** — 위에서 프롬프트에 실제로 포함된(=매칭된) 위험 패턴에 `pattern_legal_provisions`로 연결된 `legal_provisions`(주택임대차보호법 5개 조·민법 2개 조 원문, 국가법령정보센터 확인)만 `fetchLegalProvisionsForPatterns()`가 조회해 `[관련 법 조항 후보]`로 프롬프트에 추가합니다. Gemini 응답 스키마의 `detectedClauses[].legalProvisionId`는 이 후보 목록의 id 중에서만 고르도록 프롬프트에 지침을 넣었고, 서버는 응답을 받으면 그 id가 실제로 제공한 후보에 있는지 다시 검증한 뒤(환각 방지) 조문 전체 정보(`lawName`/`article`/`title`/`plainExplanation`/`sourceUrl`)로 치환해서 내려줍니다(`resolveDetectedClauses`). 20개 패턴 중 근거가 명확한 5개(#1·#7·#12·#14·#17)만 연결되어 있고 나머지는 조항 없이 `legalProvision: null`로 내려갑니다(#2·#16은 애매해서 의도적으로 제외). `/analysis`의 "발견된 유의 조항" 각 항목 아래에 `관련 법령: ○○법 제○조 — 쉬운 설명` + 국가법령정보센터 링크로 표시됩니다(legalProvision이 없으면 이 블록 자체가 안 뜸).
5. Gemini API(기본값은 `gemini-flash-latest`이지만 **2026-08-28부터 Supabase Secret `GEMINI_MODEL`을 `gemini-3.6-flash`로 고정**해 이 값이 실제로 쓰입니다 — 7장 "과거 발생했던 사고" 참고)를 멀티모달로 호출합니다. 마스킹된 이미지는 `inline_data`로 프롬프트에 직접 첨부하고, `responseSchema`로 JSON 스키마를 강제해 구조화된 응답을 받습니다. 이때 Gemini에게 요구하는 카테고리 점수는 **권리관계·특약사항·건물상태 3개뿐**입니다(전세가율은 서버가 별도로 계산 — 6번 참고). 429(과부하)/503(할당량 초과) 응답 시 `[1000ms, 3000ms]` 지연으로 최대 2회 재시도(총 3회 시도), 요청당 타임아웃 28초. 이 Gemini 호출과 6번의 전세가율 계산은 서로 무관하므로 `Promise.all`로 병렬 실행합니다. **파이프라인 단계별 소요 시간(리사이즈·CLOVA OCR·마스킹 판별·이미지 편집·패턴 필터링·법 조항 조회·Gemini 호출·전체, ms 단위)은 요청이 성공하든 502/타임아웃으로 실패하든 항상 `analyze-contract stage timings (ms)` 한 줄의 JSON 로그로 남습니다**(2026-08-28 추가 — 처음엔 성공 경로에서만 찍히게 짜서 정작 실패한 요청은 어디서 시간이 갔는지 알 수 없었고, 이후 실패 경로에서도 찍히도록 고쳤습니다). 이 로그를 이용한 502 진단 절차는 7장 "과거 발생했던 사고"를 참고하세요.
6. **전세가율은 서버가 국토부 실거래가로 직접 계산합니다(2026-08-21 추가)** — 계약서 주소를 Postgres 함수 `match_region_by_address(input_address)`에 넘겨 `region_stats`에서 가장 구체적으로 일치하는 지역을 찾고, 그 지역의 평균 매매가(건물 유형이 아파트가 아니면 연립다세대 시세 우선)와 보증금을 비교합니다. 주소가 지역과 매칭되지 않거나 그 지역의 최근 실거래가가 없으면 이 카테고리는 `score: null`("데이터 없음")이 되어 종합 점수 계산에서 제외됩니다.
7. **종합 점수(`overallScore`)는 이제 서버가 가중평균으로 계산합니다**(`_shared/contractScore.ts`의 `calculateOverallScore`, 2026-08-21 도입 — 이전에는 Gemini가 직접 산출했음. 상세 공식은 6-2 참고). Gemini의 3개 카테고리 점수 + 서버가 계산한 전세가율 카테고리를 권리관계 35% · 특약사항 30% · 전세가율 25% · 건물상태 10%로 가중평균하고, `hugLandlordCheck.isBlacklisted`가 true면(대항력 악용·신탁 부동산 등 패턴 DB와 일치) 계산 결과가 낮게 나와도 최소 61점(위험 등급 하한)으로 끌어올립니다. 카테고리 자체의 점수(권리관계/특약사항/건물상태)는 여전히 Gemini의 판단이라 비결정적이지만, **그 점수들을 종합 점수로 합치는 방식은 코드로 고정돼 있어 재현 가능**합니다.
8. Gemini가 계약서에서 추출하지 못하는(마스킹돼 있으므로) `landlordName`은 OCR로 직접 읽은 값을 서버가 응답에 주입합니다. 이 이름이 있으면 별도로 Postgres 함수 `search_hug_defaulters_by_name(query_name, min_similarity=0.4)`를 호출합니다 — `pg_trgm`의 `similarity()` 함수로 이름 컬럼만 비교하는 트라이그램 유사도 검색이며, 유사도 0.4 이상인 상위 5건을 반환합니다. 이 결과는 `hugDefaulterMatch`라는 **별도 필드**로 응답에 붙습니다 — Gemini가 패턴만 보고 "추정"한 `hugLandlordCheck`와는 명확히 구분되는, **공식 명단 대조에 기반한 사실 확인**입니다.
9. 최종적으로 `analyses` 테이블에 service_role 클라이언트로 insert합니다(주소/보증금/건물유형/점수/등급/`score_direction`/카테고리/조항/추천조치/코멘트 — 이미지·OCR 원문·임대인 성명·HUG 대조 결과는 저장하지 않음). 저장이 실패해도 사용자에게 보여줄 분석 결과 자체는 정상 반환됩니다(이력 저장 실패가 사용자 경험을 막지 않도록 설계).

**④ 결과** — `Analysis.tsx`가 응답을 `sessionStorage`에 캐싱하며 렌더링합니다(단, `landlordName`은 캐싱 직전에 제외 — 자세한 경위는 PRIVACY_FLOW.md 3.2 참고). HUG 공식 명단과 일치하면 빨간 배너("HUG 상습 채무불이행자 명단에서 발견"), AI 패턴 추정만 있으면 주황 배너("AI 위험 패턴 감지")로 시각적으로 구분해 보여줍니다. `RiskGauge`로 종합 점수, 카테고리별(권리관계·특약사항·전세가율·건물상태) 막대, 발견된 유의 조항, AI 추천 조치를 표시합니다. 점수는 "높을수록 위험"이며(안심 시그널 맵과 동일 방향), `scoreDirection`이 `'legacy_low_is_risky'`(2026-08-21 이전 이력)이면 예전 채점 기준이었다는 안내 문구로 바뀝니다.

### 3-2. 심리 가드 (가스라이팅 탐지)

**① 입력** — `Cure.tsx`의 채팅형 UI에서 텍스트(엔터로 전송, Shift+Enter 줄바꿈) 또는 캡처 이미지 1장을 첨부합니다. 대화 스레드는 `sessionStorage`(`onzip:psychGuardMessages`)에 저장되어 탭 내에서는 유지되지만 탭을 닫으면 사라집니다 — DB(`gaslighting_checks`)와는 별개의 저장소라서, 만약 DB insert가 실패해도 화면상 대화는 그대로 보입니다.

**② 처리** — `analyzeChat()`이 동일한 방식으로 base64 인코딩 후 Edge Function `analyze-chat`을 호출합니다. Gemini 호출 로직(모델명, 재시도 횟수/지연, 타임아웃)은 `analyze-contract`와 **완전히 동일하지만 코드가 별도 파일에 복사되어 있어 중복**입니다. 패턴별 확신도(재촉/허위정보 주입/신뢰 유도 각각 0~100점)와 종합 `confidence`, `aiReply`, `suggestedResponse`는 여전히 Gemini가 JSON으로 직접 산출합니다. 다만 **최종 `riskLevel`(위험/주의/안전)과 경고 여부(`isWarning`)는 2026-09-18부터 규칙 기반 `_shared/psychGuard.ts`의 `analyzePsychGuard()` 결과가 우선**합니다 — Gemini에게 "가스라이팅이 있나"를 직접 묻던 방식은 AI의 주관적 판단이라 신뢰도가 낮다고 보고, Robert Cialdini(1984)의 설득의 6원칙(희소성·권위·사회적 증거·상호성·호감·일관성) 기준 카테고리별 키워드가 메시지 텍스트에 포함(`includes`, 정규식 아님)되는지로 점수화해(카테고리 점수 = 매칭 수 × weight, 서로 다른 카테고리 2개 이상 매칭 시 +5 복합 보너스) 등급(0~20 안전/21~50 주의/51+ 위험)을 매기도록 바꿨습니다. 메시지 텍스트가 없는 이미지 전용 요청은 매칭할 텍스트가 없어 Gemini의 판단을 그대로 둡니다. `gaslighting_checks`에 service_role로 insert하는 값(위험등급 등)은 이렇게 덮어써진 최종값입니다 — Gemini의 답장 문구 `aiReply` 자체는 DB에 저장되지 않고 응답에만 포함됨).

**③ 결과** — `AnalysisPanel`이 `RiskGauge`(확신도 기준)와 패턴별 칩을 보여줍니다. 칩 색상은 점수 70 이상 위험/40 이상 주의/그 미만 안전으로 나누는 `patternTone()` 함수로 정하는데, 이 함수는 `Cure.tsx`와 `GaslightingDetail.tsx`에 **각각 복사**되어 있습니다. 사용자가 바로 복사해 쓸 수 있는 "AI 추천 대응 멘트"(`suggestedResponse`)도 함께 표시됩니다.

`/psych-guard/:id`(`GaslightingDetail.tsx`)는 프로필 이력에서 특정 대화를 클릭했을 때의 상세 화면으로, router state 없이 **id로 DB를 다시 조회**합니다(`fetchGaslightingCheckById`). 이 조회 쿼리는 `.eq('user_id', ...)` 필터가 코드상 없고 RLS 정책(`auth.uid() = user_id`)에만 접근 제어를 맡깁니다 — 마이그레이션을 확인한 결과 이 RLS 정책 자체는 정상적으로 걸려 있어 실질적인 보안 취약점은 아니지만, 다른 조회 함수들이 클라이언트에서도 이중으로 필터링하는 것과 비교하면 방어 계층이 하나 적은 구조입니다.

### 3-3. 안심 시그널 맵

이 기능은 **사용자가 요청할 때 실시간으로 계산되는 것이 아니라, pg_cron 배치가 미리 계산해 둔 `region_stats` 테이블을 프론트가 그대로 읽어오는 구조**입니다. 지도를 여는 순간 일어나는 일과, 그 데이터가 애초에 어떻게 만들어지는지를 나눠서 설명합니다.

**데이터가 만들어지는 과정 (배치, 자세한 스케줄은 4장 참고)**
1. `fetch-market-data`가 국토교통부 실거래가 API 4종(아파트 매매/전월세, 연립다세대 매매/전월세)을 지역(LAWD 코드)별로 호출해 전월 실거래 데이터를 가져오고, 지역별 평균 매매가·평균 전세가·전세가율(`전세가/매매가 × 100`)을 계산해 `region_stats`에 저장합니다.
2. `fetch-region-buzz`가 네이버 뉴스 API로 `"{지역명} 전세사기"`를 검색해 전체 검색결과 수(`total` 필드)를 `region_stats.news_mentions`에 저장합니다.
3. 두 함수 모두 배치가 끝날 때마다 `recalculateAllRiskScores()`(`_shared/riskScore.ts`)를 호출해 전체 지역의 `risk_score`/`risk_level`을 다시 계산·갱신합니다(정확한 공식은 6장 참고).

**지도를 열었을 때 (프론트, `SignalMap.tsx`)**
1. `VITE_KAKAO_MAP_KEY`로 카카오맵 SDK 스크립트를 동적으로 주입하고 로드합니다(키가 없으면 에러 메시지만 표시하고 로드를 시도하지 않음).
2. `public/data/skorea-municipalities.json`을 fetch합니다. 이 파일은 `southkorea-maps` 오픈소스의 2018년 시/군/구 TopoJSON을 `scripts/build-nationwide-geojson.mjs`(수동 실행 스크립트)로 GeoJSON 변환하면서, 법정동코드(LAWD_CD) 5자리를 각 지역에 정확히 매핑해 사전 생성해 둔 정적 파일입니다. 이름만으로 매칭하면 "중구"·"강서구"처럼 전국에 동명 지역이 여러 곳이라 코드 기반 매칭이 필요하다는 이유가 코드 주석에 명시되어 있습니다.
3. `fetchRegionStats()`(`src/lib/regionStats.ts`)로 `region_stats` 테이블 전체(약 252행)를 조회해, 지도 폴리곤의 `properties.code`(LAWD 코드)와 조인합니다.
4. `risk_level` 값(위험/주의/안전)을 미리 정해진 색상(위험 `#E5484D`, 주의 `#E8912A`, 안전 `#12A150`, 매칭 데이터 없음 `#B4B1AB`)에 매핑해 폴리곤을 칠합니다. **위험도 등급을 나누는 실제 임계값 계산은 프론트에 전혀 없고**, `region_stats`에 이미 계산되어 저장된 값을 그대로 색으로 바꿀 뿐입니다.
5. 좌측 패널에 "전세가율 50% · HUG 밀도 30% · 뉴스 언급 20%"라는 가중치 설명이 표시되는데, 이는 **UI 안내 문구로 하드코딩된 값**입니다. 실제 백엔드 공식(6장)과 일치하도록 사람이 수동으로 맞춰 둔 것이며, 프론트가 이 값을 어떤 설정이나 API에서 읽어오는 구조는 아닙니다(다행히 실제로 값이 일치함은 `_shared/riskScore.ts`를 직접 확인해 검증했습니다).
6. 지역 검색은 지역명에 검색어가 포함되는지만 보는 단순 부분일치(`includes`)로, 첫 번째로 매칭된 결과만 사용합니다(순위·복수 결과 처리 없음).

### 3-4. 인증 (이메일 / Google / Kakao)

세 방식 모두 **Supabase Auth 하나로 통합**되어 있고, 별도 `profiles` 테이블이나 커스텀 세션 관리 코드는 없습니다.

- **이메일**: `Login.tsx`는 `supabase.auth.signInWithPassword({ email, password })`, `Signup.tsx`는 `supabase.auth.signUp({ email, password, options: { data: { name, region } } })`을 호출합니다. 이름/지역은 별도 테이블이 아니라 Supabase Auth의 `user_metadata`에 저장됩니다. 이메일 확인이 필요한 프로젝트 설정이면(`data.session`이 없으면) 안내 메시지만 보여주고, 세션이 즉시 발급되면 `/home`으로 이동합니다.
- **Google / Kakao**: 두 경우 모두 `supabase.auth.signInWithOAuth({ provider: 'google' | 'kakao', options: { redirectTo: `${origin}/home` } })` 한 줄로 처리됩니다. 즉 **Kakao 로그인도 카카오 SDK를 따로 붙인 게 아니라 Supabase가 제공하는 OAuth 프로바이더 통합을 그대로 사용**합니다. "회원가입"과 "로그인" 버튼이 내부적으로 완전히 동일한 함수를 호출하는데, 이는 OAuth의 특성상 Supabase가 최초 로그인 시 사용자를 자동 생성해 주기 때문입니다. README에는 카카오 일반 개발자 앱은 이메일 동의항목이 제한되어 있어 비즈 앱 전환이 필요하다고 명시되어 있으나, 이는 카카오 개발자 콘솔 설정 사항이라 리포지토리 코드로는 확인할 수 없습니다.
- 로그인 성공/실패와 무관하게 앱 어디에도 전역 인증 컨텍스트(Context/Provider)가 없고, 각 컴포넌트가 필요할 때마다 개별적으로 `supabase.auth.getUser()`/`onAuthStateChange`를 호출합니다(예: `TopNav.tsx`, `Profile.tsx`).

### 3-5. 배치 작업 상태판 (2026-08-18 추가)

3-3에서 설명한 sync-news 401 사고(29일간 조용히 실패)가 재발하지 않도록, 마이페이지에 "배치 작업 상태" 카드를 추가했습니다. 흐름은 다음과 같습니다.

**기록(백엔드)** — 배치 4종(`fetch-market-data`, `fetch-region-buzz`, `sync-news`, `sync-hug-defaulters`)이 각자 실행을 마칠 때마다 `public.batch_job_status`(작업명 PK, `last_run_at`/`last_success_at`/`last_error`/`last_result`)에 스스로 결과를 기록합니다. Edge Function 3개는 공통 헬퍼 `_shared/jobStatus.ts`의 `recordJobRun()`을 성공 경로와 모든 실패 경로(설정 누락, 외부 API 오류, 예외)에 각각 호출하고, `scripts/sync-hug-defaulters.mjs`(GitHub Actions)는 같은 역할을 하는 동일한 로직을 자체적으로 구현해 `main()` 성공 시점과 `.catch()` 실패 시점에 호출합니다. 이번 사고에서 배웠듯 `cron.job_run_details`(pg_net의 SQL 큐잉 성공 여부)만으로는 진짜 실패를 알 수 없기 때문에, **각 함수가 스스로 "나 지금 성공/실패했다"를 직접 남기는 방식**을 택했습니다.

**조회(프론트)** — `src/lib/jobStatus.ts`의 `fetchBatchJobStatus()`가 `batch_job_status` 전체를 조회하고, `BatchJobStatusCard.tsx`가 작업마다 "마지막 갱신: N시간/일 전"과 상태 배지(✅ 정상 / ⚠️ 지연 / 🔴 중단 의심 / ❔ 기록 없음)를 보여줍니다. 상태 판정은 작업별로 하드코딩된 임계값(예: `sync-news`는 12시간 지연·24시간 중단 의심, 하루 한 번만 도는 `fetch-market-data`/`fetch-region-buzz`는 30시간·72시간, 주 1회인 `sync-hug-defaulters`는 9일·14일)을 `last_success_at`과 비교해서 프론트에서 계산합니다 — DB에 저장된 값이 아니라 컴포넌트 상수입니다.

**접근 제어(2026-08-21, 관리자 전용으로 강화)** — 원래 RLS는 `authenticated`(로그인만 하면 누구나)로 제한돼 있었는데, 이 상태판은 일반 사용자에게 노출할 이유가 없는 운영용 정보라 관리자 계정에만 조회를 허용하도록 좁혔습니다(`20260821010000_restrict_batch_job_status_to_admin.sql`). 이 프로젝트 규모(팀 4명)에서 `profiles` 테이블 + `role` 컬럼을 새로 만들기보다 단순하다는 이유로, 관리자 이메일(`s2534@e-mirim.hs.kr`)을 RLS 정책 SQL에 직접 넣는 방식을 택했습니다 — 그러면서도 DB 레벨(RLS)에서 실제로 강제된다는 요구사항은 만족합니다. 관리자가 늘어나면 `profiles.is_admin` 컬럼 + RLS로 옮기는 게 다음 단계라고 마이그레이션 주석에 남아 있습니다. `BatchJobStatusCard.tsx`는 이에 맞춰, 조회 결과가 빈 배열이면(비관리자는 RLS가 조용히 걸러내 빈 배열을 받음) 카드 자체를 렌더링하지 않습니다 — "로딩 중" 상태조차 비관리자에게 보이지 않도록 했습니다.

**한계**: 이메일/슬랙 등 능동적 알림은 없고, 관리자가 마이페이지를 직접 열어야만 보입니다(그래서 완전한 "감지"가 아니라 "눈으로 확인하면 바로 알 수 있게 만든 것"에 가깝습니다). 또한 함수가 배포조차 안 되거나 Deno 런타임 자체가 기동에 실패하는 등 코드가 전혀 실행되지 못하는 극단적 장애는 여전히 기록되지 않습니다(이번 sync-news 401 사고는 코드가 실행되긴 했으니 이 방식으로 잡혔을 것이지만, 완전히 다른 종류의 장애까지 보장하진 않습니다).

### 3-6. 마이페이지 — 분석 이력 조회 방식

`Profile.tsx`는 로그인 가드를 통과하면(`getUser()`로 확인) `Promise.all`로 두 이력을 동시에 조회합니다:
- `fetchAnalysisHistory(userId)` → `analyses` 테이블을 `user_id`로 필터, `created_at` 내림차순
- `fetchGaslightingHistory(userId)` → `gaslighting_checks` 테이블을 동일한 방식으로 필터

두 쿼리 모두 **클라이언트 코드에서 `.eq('user_id', userId)`로 한 번 필터링하고, 서버의 RLS 정책이 다시 한 번 필터링하는 이중 방어 구조**입니다(위에서 언급한 `GaslightingDetail.tsx`의 단건 조회와는 다른 패턴). 탭 전환(계약서 스캔 / 마음 상담)은 이미 받아온 두 배열을 화면에서만 바꿔 보여주는 클라이언트 사이드 전환이며, "전체보기" 버튼도 처음부터 가져온 배열을 5개씩 자르는 `.slice(0, 5)` 토글일 뿐, 실제로 더 가져오는 재조회는 일어나지 않습니다.

계약서 이력 항목을 클릭하면 `toAnalysisResult()`로 DB 행을 `AnalysisResult` 형태로 재구성해 `/analysis`로 이동합니다. 이 재구성 과정에서 `landlordName`/`hugDefaulterMatch`/`hugLandlordCheck` 필드는 애초에 이력 조회 쿼리(`ANALYSIS_COLUMNS`)에 포함되지 않아 **소실됩니다** — 즉 실시간 분석 직후에는 보였던 HUG 명단 대조 배너가, 나중에 마이페이지에서 같은 분석을 다시 열어보면 나타나지 않습니다(7장 한계에서 다시 언급). `ANALYSIS_COLUMNS`에는 `score_direction`은 포함돼 있어(2026-08-21 추가), 예전 채점 기준으로 계산된 과거 이력을 다시 열어도 `toAnalysisResult()`가 `score_direction ?? 'legacy_low_is_risky'`로 올바르게 안내 문구를 분기시킵니다 — 다만 `scoreBreakdown`(카테고리별 가중치 반영 내역)은 이력에 저장되지 않으므로 과거 이력을 다시 열면 항목별 점수/등급은 보여도 "왜 이 종합 점수가 나왔는지"의 가중치 분해는 볼 수 없습니다.

### 3-7. 계정 전환 시 세션 데이터 정리 (2026-08-21 추가)

`src/lib/sessionCleanup.ts`의 `registerSessionCleanup()`이 `src/main.tsx`에서 앱 렌더링 전에 한 번 등록됩니다. `supabase.auth.onAuthStateChange`를 구독해 로그인한 사람이 "바뀌었는지"(세션 소유자 id, 비로그인은 `'anon'`)를 `sessionStorage`의 `onzip:sessionOwner` 키와 비교하고, 바뀐 경우에만 앱이 직접 쓰는 `sessionStorage` 키(`onzip:lastAnalysis`, `onzip:psychGuardMessages`)를 지웁니다.

이 기능이 추가된 이유는 같은 탭에서 A가 로그아웃하고 B가 로그인하면(또는 비로그인 상태로 분석한 뒤 로그인하면) `sessionStorage`가 탭 단위로 유지되는 특성상 B의 화면에 A의 계약서 분석 결과·마음 상담 내용이 그대로 남아 보이던 문제 때문입니다 — 공용 PC에서 특히 위험한 개인정보 노출 경로였습니다. 소유자가 "바뀐" 경우에만 지우므로 같은 사용자의 새로고침이나 토큰 자동 갱신으로는 화면이 사라지지 않습니다. 발견 경위와 검증은 [`docs/PRIVACY_FLOW.md`](../docs/PRIVACY_FLOW.md)에 기록돼 있습니다.

---

## 4. 자동화(배치) 작업 목록

### 4-1. Supabase pg_cron (Postgres 내부 스케줄러, 최종 3개 작업)

| 작업명 | 스케줄(UTC) | 실제 시각(KST) | 대상 | 타임아웃 |
|---|---|---|---|---|
| `fetch-market-data-batch` | `*/20 18-20 * * *` | 03:00~05:40, 20분 간격 하루 9회 | `fetch-market-data` 함수 | 120,000ms |
| `fetch-region-buzz-batch` | `10-50/20 18-20 * * *` | 03:10~05:50, 20분 간격 하루 9회(시장데이터보다 10분 늦게) | `fetch-region-buzz` 함수 | 120,000ms |
| `sync-news` | `0 */6 * * *` | 매 6시간(00/06/12/18시 UTC) | `sync-news` 함수 | 30,000ms |

**왜 배치로 나누는가**: Supabase Edge Function은 실행시간 제한(약 150초)이 있는데, 전국 시/군/구는 252개 지역입니다. 하나의 함수 호출로 전부 처리할 수 없어서, `region_sync_cursor` 테이블에 진행 상태(다음에 처리할 지역 인덱스, 오늘 날짜의 사이클)를 저장해두고 한 번에 `BATCH_SIZE`개씩만 처리한 뒤 커서를 갱신하는 방식으로 나눠 돌립니다. 애초 배치 크기는 50개였지만, 연립다세대(빌라) 실거래가 조회가 추가되면서 지역당 처리시간이 약 0.3초에서 2.7초로 늘어나 30개(30×2.7초≈81초, 150초 제한 내 안전마진 확보)로 낮췄고, 그 결과 하루에 필요한 실행 횟수도 `ceil(252/50)=6회`에서 `ceil(252/30)=9회`로 늘어 위 스케줄이 확정되었습니다. 이 조정 과정이 마이그레이션 파일명(`batch_region_stats_cron` → `fix_region_stats_cron_timeout` → `expand_batch_cron_for_villa`)에 그대로 남아 있습니다. 두 배치 사이 20분 텀은 국토부/네이버 API 호출량을 배려한 것이고, 지역 간에도 각각 200ms/150ms의 짧은 딜레이를 둡니다.

`sync-news`는 지역별 배치가 아니라 "전세사기" 키워드로 뉴스 20건을 한 번에 가져와 갱신하는 단발성 작업이라 커서 없이 6시간마다 통째로 돕니다. 다만 다른 두 배치 함수와 달리 `x-cron-secret` 인증을 요구하지 않고(`verify_jwt`가 기본값 `true`인데 실제 호출부에는 인증 헤더가 전혀 없는 설정 불일치가 있음 — 7장 참고), 실제로 2026-07-18~21 사이 이 작업의 호출 URL이 `analyze-contract`로 잘못 설정되어 있어 `news` 테이블이 며칠간 갱신되지 않은 채로 "성공"으로 기록된 사고가 있었고, 이는 URL을 고친 마이그레이션(`fix_sync_news_cron_url`)으로 해결되었습니다.

### 4-2. GitHub Actions (Supabase 밖, 1개 워크플로)

| 워크플로 | 스케줄 | 실행 내용 |
|---|---|---|
| `.github/workflows/sync-hug-defaulters.yml` | `0 20 * * 0` (UTC 일요일 20시 = **KST 매주 월요일 05:00**) + `workflow_dispatch`(수동 실행) | `scripts/sync-hug-defaulters.mjs` 실행 |

**왜 Edge Function이 아니라 별도 스크립트인가**: HUG 안심전세포털의 상습채무불이행자 명단은 여러 페이지로 나뉘어 있고(현재 200페이지대, 페이지 하단의 "N / M" 텍스트를 정규식으로 파싱해 총 페이지 수를 그때그때 동적으로 감지 — 코드에 하드코딩된 숫자가 아님), 정부 사이트에 대한 예의상 페이지마다 500ms~1초 랜덤 지연을 둡니다. 이렇게 되면 전체 크롤링에 Edge Function의 실행시간 제한을 훌쩍 넘는 시간이 걸리기 때문에, GitHub Actions(워크플로 타임아웃 30분)에서 Node 스크립트로 독립 실행합니다. 페이지의 HTML은 서버에서 완성된 테이블로 내려오므로 브라우저 렌더링(Playwright 등) 없이 `cheerio`로 파싱하고, EUC-KR로 인코딩된 원문을 `iconv-lite`로 디코딩합니다. 각 행은 이름/주소/보증금반환채무 등을 조합한 해시(`raw_row_hash`)를 고유키 삼아 500건씩 배치로 `hug_defaulters` 테이블에 upsert됩니다(소스에 고유 ID가 없어 해시로 중복을 방지).

**2026-09-18 재시도/체크포인트 추가**: 실제 운영에서 180페이지쯤부터 `ConnectTimeoutError`(undici 기본 연결 타임아웃 10초)로 실패하는 사례가 있어(HUG 측 속도 제한/봇 방지로 추정), 다음을 추가했습니다 — ① 페이지 요청 실패 시 2~3초 대기 후 최대 3회까지 재시도, ② undici `Agent`로 연결 타임아웃을 10초 → 25초(헤더/바디 30초)로 상향, ③ 일반 브라우저 User-Agent로 교체, ④ 20페이지마다 그때까지 모은 행을 즉시 `hug_defaulters`에 upsert(끝까지 기다렸다 한 번에 쓰지 않음). 그래도 재시도 3회를 모두 소진해 실패하면, 그 시점까지 처리한 페이지 번호를 `batch_job_status.last_result`(`resumeFromPage`)에 기록하고, 다음 실행이 시작할 때 이 값을 읽어 처음부터가 아니라 실패 지점부터 이어서 처리합니다(성공하면 체크포인트는 자동 초기화). 새 테이블이나 파일 없이 기존 `batch_job_status`(3-5 참고)를 재활용했습니다.

### 4-3. 배치 상태 모니터링

위 4개 배치(3개 pg_cron 함수 + HUG 크롤러)는 모두 실행이 끝날 때마다 `batch_job_status` 테이블에 스스로 마지막 성공 시각을 기록하고, 마이페이지에서 이를 예상 주기와 비교해 지연/중단 여부를 보여줍니다. 자세한 구조는 3-5 참고.

### 4-4. 자동화되지 않은 스크립트 (수동 실행 전용)

- `scripts/generate-regions.mjs` — 법정동코드 CSV에서 전국 시/군/구 지역 목록을 생성해 `supabase/functions/_shared/regions.generated.ts`를 만드는 스크립트. `npm run generate:regions`로 실행 가능하지만 어떤 CI/cron에도 연결되어 있지 않습니다. 지역 목록이 바뀔 때만 사람이 직접 돌립니다.
- `scripts/build-nationwide-geojson.mjs` — 지도 폴리곤 원본(TopoJSON)에 법정동코드를 매핑해 `public/data/skorea-municipalities.json`을 만드는 스크립트. `package.json`의 npm script로도 등록되어 있지 않고 완전히 수동 실행 전용입니다.

---

## 5. 데이터베이스 테이블 전체 목록

`pg_trgm`(트라이그램 유사도), `pg_cron`, `pg_net`, `supabase_vault` 확장이 사용됩니다. 아래는 마이그레이션을 순서대로 적용했을 때의 최종 스키마 기준입니다.

| 테이블 | 역할 | 주요 컬럼 | 쓰는 주체 | 읽는 주체 | RLS |
|---|---|---|---|---|---|
| `analyses` | 계약서 스캔 결과 이력 | `user_id`(FK, cascade delete), `address`, `deposit`, `building_type`, `overall_score`, `risk_level`(danger/warning/success), `score_direction`(`high_is_risky`/`legacy_low_is_risky`, not null, 2026-08-21 추가 — 아래 참고), `categories`/`detected_clauses`/`recommended_actions`(jsonb), `ai_comment` | `analyze-contract` 함수(service_role) | `Profile.tsx`(`fetchAnalysisHistory`, 본인 것만) | 활성. `authenticated`가 `auth.uid()=user_id`인 행만 SELECT 가능. INSERT 정책 없음(service_role은 RLS 우회) |
| `gaslighting_checks` | 마음 상담(가스라이팅) 분석 이력 | `user_id`(FK, cascade delete), `input_text`, `risk_level`(위험/주의/안전), `confidence`(0~100), `patterns`(jsonb), `suggested_response` | `analyze-chat` 함수(service_role) | `Profile.tsx`, `GaslightingDetail.tsx`(id로 단건) | 활성. `authenticated`가 `auth.uid()=user_id`인 행만 SELECT 가능 |
| `news` | 전세사기 관련 뉴스 캐시 | `title`, `url`(unique), `media`, `published_at` | `sync-news` 함수(service_role) | `Home.tsx`(`fetchLatestNews`) | 활성. `anon`/`authenticated` 모두 전체 SELECT 가능(공개 데이터) |
| `region_stats` | 지역별 위험도 맵 데이터 | `region_code`(unique, LAWD), `region_name`, `avg_sale_price`/`avg_jeonse_price`/`jeonse_ratio`(아파트), `villa_avg_sale_price`/`villa_avg_jeonse_price`/`villa_jeonse_ratio`, `news_mentions`, `hug_defaulter_count`, `risk_score`, `risk_level`(위험/주의/안전) | `fetch-market-data`, `fetch-region-buzz` 함수(service_role) | `SignalMap.tsx`(`fetchRegionStats`, 전체) | 활성. `anon`/`authenticated` 모두 전체 SELECT 가능 |
| `region_sync_cursor` | 지역 배치 처리 진행 상태 | `sync_name`(PK), `next_index`, `cycle_date` | `fetch-market-data`/`fetch-region-buzz` 내부(`_shared/regionBatch.ts`) | 위 두 함수만 | 활성, **정책 없음**(service_role만 접근 가능, anon/authenticated는 기본 차단) |
| `contract_risk_patterns` | 계약서 분석용 위험 패턴 지식베이스 | (아래 스키마 이력 참고) | 수동 시딩 | `analyze-contract`(전체 SELECT) | 활성. `anon`/`authenticated`는 SELECT만 가능, INSERT/UPDATE/DELETE/TRUNCATE는 명시적으로 REVOKE됨 |
| `pattern_sources` | `contract_risk_patterns`(20건) 전체가 공통으로 참고한 출처 자료 3건(2026-08-26 추가) | `organization`, `title`, `description`, `url` | 마이그레이션 시딩(`20260826000000_create_pattern_sources.sql`) | `ScoringGuide.tsx`(`fetchPatternSources`), `Analysis.tsx`(고정 안내 문구로만 인용, 조회는 안 함) | 활성. `anon`/`authenticated`는 SELECT만 가능, INSERT/UPDATE/DELETE/TRUNCATE는 명시적으로 REVOKE됨 |
| `legal_provisions` | 위험 패턴의 법적 근거가 되는 실제 조문 7건(주택임대차보호법 5개 조·민법 2개 조, 2026-08-28 추가) | `law_name`, `article`, `title`, `content`(원문, 국가법령정보센터 확인), `plain_explanation`, `source_url` | 마이그레이션 시딩(`20260828000000_create_legal_provisions.sql`) | `analyze-contract`(`fetchLegalProvisionsForPatterns`) | 활성. `anon`/`authenticated`는 SELECT만 가능, INSERT/UPDATE/DELETE/TRUNCATE는 명시적으로 REVOKE됨 |
| `pattern_legal_provisions` | `contract_risk_patterns`↔`legal_provisions` 다대다 연결(확정된 5개 패턴, 7행. #2·#16은 애매해 제외, 2026-08-28 추가) | `pattern_id`(FK), `legal_provision_id`(FK), 복합 PK | 마이그레이션 시딩(`20260828000001_create_pattern_legal_provisions.sql`) | `analyze-contract`(`fetchLegalProvisionsForPatterns`) | 활성. `anon`/`authenticated`는 SELECT만 가능, INSERT/UPDATE/DELETE/TRUNCATE는 명시적으로 REVOKE됨 |
| `legal_terms` | 법률 용어 21건(원래 요청 20개 + 법정 명칭 정정으로 추가된 "계약갱신요구권") 공식 정의 사전(2026-09-03 추가) | `term`(unique), `official_definition`, `plain_explanation`(아직 미입력), `category`(미사용), `source`, `related_provision_id`(FK, 일부만 연결) | `scripts/fetch-legal-terms.mjs`(법제처 API), `scripts/backfill-legal-terms-from-provisions.mjs`(legal_provisions 재활용), 수동 시딩 마이그레이션 1건 | (아직 프론트에서 조회하는 곳 없음 — 데이터만 구축된 상태) | 활성. `anon`/`authenticated`는 SELECT만 가능, INSERT/UPDATE/DELETE/TRUNCATE는 명시적으로 REVOKE됨 |
| `hug_defaulters` | HUG 상습채무불이행자 명단 로컬 캐시 | `name`, `age`, `address`, `deposit_return_debt`, `debt_occurred_at`, `guarantee_payment_at`, `reimbursement_debt`, `execution_count`, `base_date`, `raw_row_hash`(unique, upsert 키) | `scripts/sync-hug-defaulters.mjs`(service_role, GitHub Actions) | `analyze-contract`(이름 유사도 검색), `_shared/riskScore.ts`(지역별 카운트) | 활성. `anon`/`authenticated` 전체 SELECT 가능 |
| `hug_sync_cursor` | HUG 크롤링 진행 상태(단일 행) | `id`(PK, 항상 1), `last_page`, `total_pages` | (현재 크롤러 스크립트에서 직접 갱신하지는 않고 구조만 존재 — 아래 7장 참고) | — | **한때 RLS 미적용 상태였음** — 아래 참고 |
| `batch_job_status` | 배치 4종의 마지막 실행/성공 시각·에러 기록 (2026-08-18 추가, 3-5 참고) | `job_name`(PK), `last_run_at`, `last_success_at`, `last_error`, `last_result`(jsonb) | 4개 배치(3개 Edge Function + `sync-hug-defaulters.mjs`) 각자 service_role로 자가 기록 | `Profile.tsx`의 `BatchJobStatusCard`(`fetchBatchJobStatus`) | 활성. **관리자 이메일만 SELECT 가능**(2026-08-21부터 `authenticated`→admin으로 강화, 3-5 참고) |

**RLS 관련 특이사항**: `hug_sync_cursor`는 생성 당시(마이그레이션 `20260721000001`) RLS를 켜는 구문이 누락되어, `anon`/`authenticated` 기본 권한이 그대로 노출된 채로 한동안 존재했습니다. 이후 별도 보안 감사에서 발견되어 `20260721000007_enable_rls_hug_sync_cursor.sql`로 RLS를 활성화(정책은 추가하지 않아 결과적으로 service_role만 접근 가능)했습니다. `contract_risk_patterns` 역시 한 시점에 원격 DB에서 테이블이 수동으로 재생성되며 RLS가 꺼진 채로 방치되어 `anon` 키로 쓰기가 가능했던 이력이 있었고, 이 역시 같은 감사에서 발견되어 `20260721000005` 마이그레이션으로 RLS 재활성화 및 쓰기 권한 REVOKE로 조치되었습니다.

**`analyses.score_direction` — 점수 방향 반전에 따른 신/구 데이터 구분(2026-08-21)**: 계약서 종합 점수 체계가 "낮을수록 위험"에서 안심맵과 같은 "높을수록 위험"으로 바뀌면서(6-2 참고), 이미 저장된 과거 행은 옛 기준으로 계산된 값이라 새 기준으로 그대로 해석하면 안 됩니다. `20260821010100_add_analyses_score_direction.sql`이 이 컬럼을 추가하면서, 마이그레이션 시점에 이미 존재하던 행은 전부 `'legacy_low_is_risky'`로, 그 이후 새로 저장되는 행은 기본값 `'high_is_risky'`로 채워집니다. 값을 기계적으로 반전(100-score)하지 않은 이유는 과거 값이 Gemini의 자유 판단이라 새 계산식과 수학적으로 정확히 대응한다는 보장이 없기 때문이며(애초에 이 리워크의 계기), 대신 프론트(`Analysis.tsx`)가 이 컬럼을 보고 과거 이력에는 "예전 채점 기준" 안내를 표시합니다.

**`risk_level` 값 체계가 테이블마다 다릅니다**: `analyses`는 영어(`danger`/`warning`/`success`), `gaslighting_checks`·`region_stats`는 한글(`위험`/`주의`/`안전`)을 씁니다. 기능적으로 문제는 없지만(각자 자기 테이블 안에서만 일관되게 사용) 하나의 코드베이스 안에 두 가지 어휘가 공존하는 점은 알아두어야 합니다.

**`contract_risk_patterns` 스키마 이력 — 코드상 실제로 꼬여 있는 부분**: 최초 마이그레이션(`20260721000000`)은 `category`/`pattern_description`/`risk_level`/`example_clause`/`source`/`keywords`/`search_vector`(생성 컬럼, tsvector) 스키마로 테이블을 만듭니다. 이후 시딩 마이그레이션(`20260721000002`)도 이 컬럼명을 그대로 씁니다. 그런데 `20260721000005`는 주석으로 "실제 운영 DB는 2026-07-20에 수동으로 `pattern_name`/`description`/`severity`/`recommended_action` 스키마로 재생성되었다"고 밝히면서, 동일한 `create table if not exists` 구문을 다시 씁니다. **`IF NOT EXISTS` 때문에, 이 마이그레이션들을 처음부터 순서대로 재생하면(예: 새 환경에 배포) 최초 스키마(구 컬럼명)가 그대로 유지되고 새 스키마로 바뀌지 않습니다** — 즉 "마이그레이션 파일이 기술하는 스키마"와 "실제 운영 DB의 현재 스키마"가 서로 다를 수 있는 상태입니다. 현재 `analyze-contract` 함수 코드는 새 컬럼명(`pattern_name`, `description`, `severity`, `recommended_action`)으로 쿼리하므로, 최초 스키마 그대로인 환경에서는 이 쿼리가 실패합니다. 새 마이그레이션으로 정리되지 않은 기술 부채입니다.

**RPC 함수 3종**(모두 마이그레이션에서 `create or replace function`으로 정의):
- `search_hug_defaulters_by_name(query_name, min_similarity=0.4)` — 이름 컬럼에 대한 `pg_trgm` 유사도 검색, 상위 5건. `analyze-contract`가 계약서에서 추출한 임대인 이름을 확인할 때 사용.
- `hug_defaulter_region_counts()` — `hug_defaulters.address`를 정규식(한글 단어 경계 패턴)과 시/도 약칭↔정식명 별칭 테이블로 `region_stats.region_name`에 매칭해 지역별 명단 건수를 집계. 유사도가 아니라 **정확한 토큰 매칭**이며, "남동구"가 "동구"에 잘못 매칭되는 것을 막기 위한 경계 처리가 되어 있습니다. `_shared/riskScore.ts`가 지역 위험도 계산 시 호출.
- `match_region_by_address(input_address)`(2026-08-21 추가) — 계약서에서 추출한 매물 주소(자유 텍스트)로 `region_stats`에서 가장 구체적으로(region_name이 가장 긴) 일치하는 지역 하나를 찾아 `region_code`/`avg_sale_price`/`villa_avg_sale_price`를 반환합니다. 매칭 방식은 `hug_defaulter_region_counts()`와 동일한 토큰·별칭 매칭 로직을 재사용하되, 이쪽은 지역별 집계가 아니라 입력 주소 하나를 전체 지역과 비교해 단일 매칭을 찾는 용도입니다. `analyze-contract`가 전세가율 카테고리를 계산할 때 호출하며, `service_role`에만 EXECUTE 권한을 부여합니다(anon/authenticated는 직접 호출할 이유가 없음).

---

## 6. 위험도 점수 산출 로직

이 프로젝트에는 계약서 위험도와 안심맵 지역 위험도, 두 가지 "위험도"가 있습니다. 2026-08-21 이전에는 계약서 위험도가 Gemini 판단을 그대로 쓰는 값이라 안심맵과 성격이 완전히 달랐지만, 이제 **둘 다 최종 점수는 서버 코드가 결정론적 공식(가중평균)으로 계산**합니다. 다만 계약서 위험도는 그 공식에 들어가는 입력값 중 3개(권리관계·특약사항·건물상태 카테고리 점수)가 여전히 Gemini의 판단이라, "결합 방식은 재현 가능하지만 입력값 자체는 비결정적"이라는 절충 상태라는 점이 두 위험도의 진짜 차이입니다. 멘토링에서 헷갈리기 쉬운 지점이라 아래에서 명확히 구분합니다.

### 6-1. 안심맵 지역 위험도 — 코드로 계산되는 확정 수식

`supabase/functions/_shared/riskScore.ts`에 정의되어 있고, `fetch-market-data`/`fetch-region-buzz` 배치가 끝날 때마다 전체 지역에 대해 다시 계산됩니다.

**1단계 — 세 지표를 각각 0~100점 구간 점수로 변환** (모두 구간별 선형 보간, 상한 이후는 값 고정):

- 전세가율 점수(`jeonseRatioScore`): 80% 이하는 0~30점, 80~100%는 30~60점, 100~130%는 60~90점, 130% 초과는 90~100점(150%에서 100점 도달, 그 이상은 100점 고정). "깡통전세" 위험이 100%를 넘는 구간에서 점수가 너무 완만하게 오르지 않도록 구간을 잘게 나눴습니다.
- 뉴스 언급 점수(`newsMentionScore`): 0~5건은 0~20점, 6~20건은 20~50점, 21건 이상은 50~100점(50건에서 100점 도달, 그 이상 고정).
- HUG 밀도 점수(`hugDefaulterScore`): 0~5건은 0~20점, 6~22건은 20~60점, 23건 이상은 60~100점(90건에서 100점 도달, 그 이상 고정). 5/22/90이라는 경계값은 2026년 7월 크롤링 기준 252개 지역의 실제 분포(중앙값 5, 90번째 백분위수 22, 최댓값 91)를 근거로 정해졌다고 코드 주석에 명시되어 있습니다.

**2단계 — 아파트/빌라 전세가율을 하나로 합산**: 아파트 30% + 빌라(연립다세대) 70% 가중 평균(`effectiveJeonseRatio`). 한쪽 데이터가 그 달에 없으면 있는 쪽만 사용합니다. 빌라에 더 큰 가중치를 준 이유는 "전세사기는 시세 파악이 어려운 빌라에서 압도적으로 많이 발생하고, 아파트는 실거래가가 투명해 상대적으로 안전하다"는 주석 설명입니다.

**3단계 — 최종 결합**:

```
riskScore = round((전세가율점수 × 0.5 + HUG밀도점수 × 0.3 + 뉴스언급점수 × 0.2) × 10) / 10
riskLevel = riskScore ≥ 70 → '위험'
            riskScore ≥ 40 → '주의'
            그 외        → '안전'
```

이 50%/30%/20% 가중치가 바로 `SignalMap.tsx` 사이드바에 안내되는 수치와 정확히 일치합니다(README와 UI 문구가 실제 코드와 맞는 몇 안 되는 정량적 주장 중 하나로, 직접 대조 확인했습니다). 한 가지 예외 처리로, 그 달 아파트·빌라 실거래가 데이터가 둘 다 없는 지역은 `jeonseRatio`가 `null`이 되어 `calculateRisk()`가 아예 `null`을 반환하고 — 이 경우 기존에 저장돼 있던 `risk_score`/`risk_level` 값이 그대로 남습니다(즉 오래된 값일 수 있고, 화면에서 이를 구분해서 보여주지는 않습니다).

### 6-2. 계약서 위험도 — 이제 서버가 가중평균으로 계산 (2026-08-21 개편)

이전에는 **계약서의 `overallScore`(0~100)와 `riskLevel`을 Gemini가 직접 산출**해 서버는 JSON을 그대로 파싱해 쓰는 구조였고, 재현성이 보장되지 않는다는 문제가 있었습니다(같은 계약서를 두 번 올려도 값이 달라질 수 있었음). `_shared/contractScore.ts`가 이 문제를 해결하기 위해 도입됐습니다 — Gemini의 역할을 "카테고리별 위험도 판단"으로 좁히고, **그 판단들을 종합 점수로 합치는 계산은 서버 코드가 고정된 공식으로 수행**합니다.

**입력 — 카테고리 4개**:
1. 권리관계, 특약사항, 건물상태 — Gemini가 각각 0~100점(높을수록 위험)으로 채점(3-1의 ③-4 참고). 이 3개는 여전히 Gemini의 비결정적 판단입니다.
2. 전세가율 — 서버가 `match_region_by_address` RPC로 계약서 주소를 지역에 매칭하고, 그 지역의 국토부 실거래가 평균 매매가와 보증금을 비교해 계산(3-1의 ③-5 참고, 안심맵과 동일한 `jeonseRatioScore()` 곡선 재사용). 매칭 실패·시세 데이터 없음이면 `score: null`.

**결합 — `calculateOverallScore(categories, hasCriticalPattern)`**:

```
CATEGORY_WEIGHTS = { 권리관계: 0.35, 특약사항: 0.30, 전세가율: 0.25, 건물상태: 0.10 }

overallScore = round( Σ (카테고리 점수 × 정규화된 가중치) )
  # 정규화: score가 null인 카테고리는 계산에서 제외하고, 남은 카테고리끼리 가중치 합이 1이 되도록
  # 다시 나눈다(예: 전세가율이 데이터 없음이면 나머지 3개가 35/30/10을 남은 비율로 재분배).

hasCriticalPattern(= Gemini의 hugLandlordCheck.isBlacklisted)가 true면:
  overallScore = max(overallScore, 61)   # CRITICAL_PATTERN_FLOOR — 계산상 안전해 보여도
                                          # 확인된 위험 패턴이 있으면 강제로 위험 등급 하한까지 끌어올림

riskLevel = overallScore > 60 → 'danger'   # DANGER_THRESHOLD
            overallScore > 30 → 'warning'  # SUCCESS_THRESHOLD
            그 외             → 'success'
```

DANGER_THRESHOLD(60)와 SUCCESS_THRESHOLD(30)는 코드 주석에 따르면 개편 전 "40점 미만 = danger(낮을수록 위험)" 기준을 방향만 반전(100-40=60)해 대칭적으로 유도한 값입니다.

**HUG 명단 실명 대조(`hugDefaulterMatch`)는 이 공식과 별개**입니다 — 서버가 직접 SQL로 계산한 사실 확인 값이지만, `overallScore` 계산에는 관여하지 않고 응답에 별도 필드로만 붙습니다(화면에서는 빨간 배너로 별도 표시).

**남은 비결정성**: 종합 점수를 만드는 결합 공식 자체는 100% 재현 가능하지만, 입력값인 권리관계·특약사항·건물상태 3개 카테고리 점수는 여전히 Gemini가 매번 새로 판단하는 값이라 완전한 재현성은 아닙니다(전세가율만 완전한 결정론). 심리 가드의 패턴별 확신도/`confidence`는 이번 개편과 무관하게 이전과 동일하게 Gemini가 산출한 값을 그대로 쓰지만, **최종 `riskLevel`/`isWarning`은 2026-09-18부터 규칙 기반 `analyzePsychGuard()`가 결정**해 계약서 위험도와 마찬가지로 "최종 판정 자체는 재현 가능, 일부 세부 값은 비결정적"인 절충 구조가 됐습니다(3-2 참고).

**점수 방향과 등급 경계는 앱 내 `/scoring`(`ScoringGuide.tsx`) 페이지에도 노출됩니다** — 이 화면은 `CATEGORY_WEIGHTS`/`calculateOverallScore`의 값을 하드코딩된 표로 옮겨 보여줄 뿐 실제 상수를 import하지는 않으므로, `_shared/contractScore.ts`나 `_shared/riskScore.ts`의 값이 바뀌면 `ScoringGuide.tsx`도 사람이 함께 고쳐야 합니다(코드 주석에 "같은 값을 유지해야 한다"고 명시돼 있음 — 7장의 코드 품질 항목 참고).

---

## 7. 알려진 한계와 미해결 과제

코드에 리터럴 `TODO`/`FIXME` 주석은 없었습니다(전체 `src/`, `supabase/` 검색 결과 0건). 다만 실질적으로 TODO에 해당하는 주석과, 코드를 직접 읽어야만 드러나는 한계들은 다음과 같습니다.

**정확도·재현성 관련**
- 계약서 위험 점수(`overallScore`, `riskLevel`)는 2026-08-21부터 종합 점수 결합 방식은 서버 공식으로 고정됐지만(6-2 참고), 그 입력값인 권리관계·특약사항·건물상태 3개 카테고리 점수는 여전히 Gemini가 매번 새로 판단하는 값이라 완전한 재현성은 아닙니다(전세가율만 완전한 결정론).
- `analyze-contract`의 "RAG"는 2026-08-28부터 OCR 텍스트와 패턴별 큐레이션 키워드를 대조해 관련 있는 패턴만 프롬프트에 넣도록 바뀌었습니다(매칭 0건이거나 OCR 텍스트가 없으면 20건 전체로 안전하게 폴백 — 3-1 3번 참고). 하지만 이는 진짜 유사도 검색이 아니라 사람이 손으로 고른 키워드의 부분 문자열 매칭이라, 키워드 목록에 없는 표현으로 위험 신호가 있으면 여전히 놓칠 수 있습니다 — 작성자가 남긴 "테이블이 커지면 검색 기반(벡터 임베딩·tsvector)으로 바꿀 것"이라는 주석은 여전히 유효한 다음 단계입니다. (2026-08-26 갱신: 이 20건 자체의 출처는 `pattern_sources` 테이블에 기록되어 더 이상 불명확하지 않습니다 — 3-1 참고.)
- `region_stats`의 위험도는 그 달 실거래 데이터가 없는 지역의 경우 갱신되지 않고 이전 값이 그대로 유지되며, 화면에서 이를 "오래된 데이터"로 구분해 보여주지 않습니다.
- HUG 명단-지역 매칭(`hug_defaulter_region_counts`)은 정규식 토큰 매칭이라 주소 표기가 특이한 케이스는 누락될 수 있습니다(README의 "98.9% 매칭" 같은 구체적 수치는 코드 어디에도 계산·저장되어 있지 않아 검증이 불가능합니다 — 실제 매칭률을 추적하는 로직 자체가 없습니다).

**미구현**
- 마이페이지의 알림 설정(위험 알림/분석 알림/마케팅 알림) — UI 자체에 "설정은 저장되지 않아요"라고 명시된 완전한 스텁입니다.
- 회원가입 시 수집하는 `region` 필드 — `user_metadata`에 저장만 되고 이후 어디에서도(마이페이지 표시, 지도 초기 위치 등) 사용되지 않습니다.
- 실시간 실거래가 조회 — 사용자가 지도를 볼 때 즉석에서 계산하는 게 아니라 최대 20분~하루 전에 배치가 계산해 둔 값을 보여줍니다.

**설정/구성 불일치 (2026-08-18 확인 및 수정 완료)**
- `sync-news` cron 작업은 인증 헤더를 전혀 보내지 않는데, 해당 Edge Function은 `verify_jwt` 기본값(`true`)을 그대로 쓰고 있었습니다. 이 문서 초판에서는 "리포지토리 코드만으로는 확정할 수 없다"고 적었지만, 실제 운영 DB(`cron.job_run_details`, `net._http_response`)를 직접 조회해 확정했습니다: **2026-07-20 16:25(KST) 마지막 정상 실행 이후 29일간 매 6시간마다 401 Unauthorized로 거부**되고 있었고, `cron.job_run_details`는 `net.http_post`의 비동기 특성 때문에 계속 "succeeded"로만 기록되어 있어 장애가 숨겨져 있었습니다(진짜 HTTP 결과는 `net._http_response`에서만 확인 가능). `fetch-market-data`/`fetch-region-buzz`와 동일하게 `verify_jwt=false` + `x-cron-secret` 자체 검증 패턴으로 통일해 수정했고(`20260818140000_fix_sync_news_auth.sql`), 수동 트리거로 뉴스 20건 정상 동기화(`{"synced":20}`, HTTP 200)를 확인했습니다.
- `contract_risk_patterns` 테이블은 마이그레이션 파일이 기술하는 스키마와 실제 운영 DB 스키마가 다를 가능성이 있는 상태로 남아 있습니다(5장 참고). 새 컬럼명을 쓰는 것은 애플리케이션 코드뿐이고, 마이그레이션은 정리되지 않았습니다.
- `contract_risk_patterns` GIN 인덱스(카테고리, 키워드 배열, `search_vector`)가 최초 마이그레이션에 정의되어 있지만, 현재 쿼리 코드(전체 SELECT)는 이 인덱스들을 전혀 활용하지 않는 죽은 인프라입니다.

**과거 발생했던 사고(코드/마이그레이션에 기록으로 남아있음)**
- `sync-news` cron의 호출 URL이 `analyze-contract`로 잘못 설정되어 2026-07-18~21 사이 뉴스 테이블이 갱신되지 않은 채 "성공"으로 로그에 남았던 사고.
- `hug_sync_cursor`, `contract_risk_patterns`가 한때 RLS 없이 노출되어 있던 시점이 있었음(보안 감사로 발견 후 조치).
- **2026-08-28 `analyze-contract` 502/타임아웃 — 해결됨** — `analyze-contract`가 Gemini 호출에서 반복적으로 28초 타임아웃(최대 3회 재시도 후 502)에 걸린다는 보고가 있어, 처음엔 `contract_risk_patterns` 20건 전체를 프롬프트에 넣는 게 원인이라고 가정하고 위 키워드 필터링(3-1 3번)을 도입했습니다. 그런데 필터링 적용 후에도(실제로 20건 → 2~3건으로 정확히 줄어든 것을 `Risk pattern filter` 로그로 확인) 여전히 71~92초씩 걸리며 실패했고, 실패 응답 본문에는 `"This model is currently experiencing high demand... status: UNAVAILABLE"`(HTTP 503)이 담겨 있었습니다. **이미지 없이 주소만 보내는 가장 가벼운 요청도 89~92초 만에 똑같이 타임아웃**나는 것을 확인해, 프롬프트 크기가 아니라 **`gemini-flash-latest`가 가리키는 모델 자체가 그 시점에 구글 쪽에서 과부하 상태였다**고 결론지었습니다.
  - **원인 규명 및 조치**: `GEMINI_API_KEY`를 새로 발급받아 교체해봤지만 동일하게 실패해(키/쿼터 문제가 아님을 확인) `GEMINI_MODEL`을 특정 버전으로 직접 고정해보기로 했습니다. 처음 시도한 `gemini-2.0-flash`는 4초 만에 `404 NOT_FOUND`(`"This model models/gemini-2.0-flash is no longer available... use models/gemini-3.6-flash"`)로 즉시 실패해 — 이건 과부하가 아니라 **완전히 폐기된 모델명**이었다는 별개의 문제였습니다(진단 과정에서 나온 곁가지). 구글이 안내한 대로 `GEMINI_MODEL=gemini-3.6-flash`로 고정하자 16~20초 만에 정상 응답(HTTP 200)했고, 이미지 첨부·패턴 필터링(3건 매칭)·법 조항 연동(`legalProvisionId` → 민법 제623조)·프론트 렌더링까지 전 구간이 실제로 정상 동작하는 것을 스크린샷으로 확인했습니다.
  - **현재 설정**: `GEMINI_MODEL` Supabase Secret이 `gemini-3.6-flash`로 고정되어 있습니다(코드 기본값은 여전히 `gemini-flash-latest`이지만 Secret이 이를 덮어씀). `-latest` 별칭에 계속 의존하면 오늘처럼 과부하나 예고 없는 모델 교체에 다시 노출될 수 있어, 별다른 지시가 없는 한 이 고정값을 유지합니다.
  - **다음에 비슷한 502/타임아웃이 나면**: 프롬프트 최적화부터 의심하지 말고 먼저 (1) `analyze-contract stage timings (ms)` 로그에서 `gemini` 필드 값과 `matchedPatternCount`를 확인하고, (2) `fileBase64` 없이 주소만 보내는 최소 요청으로 Gemini가 지금 정상 응답하는지 확인하세요. 이 최소 요청조차 타임아웃나면 Gemini API 자체(구글 쪽 할당량/상태/모델 폐기 여부)의 문제이지 이 코드베이스의 버그가 아닙니다. 실패 응답 본문의 에러 메시지(`status: UNAVAILABLE`, `NOT_FOUND` 등)를 확인하면 원인을 빠르게 구분할 수 있습니다.
- **2026-09-03 `legal_terms`(법령 용어 공식 정의) 구축** — 법제처 국가법령정보 공동활용 API로 21개 법률 용어(대항력·보증금 등)의 공식 정의를 채우는 작업. 처음엔 `MOLEG_API_OC` 인증이 계속 "필수입력요소 검증 실패"로 막혔는데, 원인은 파라미터 누락이 아니라 **법제처 오픈API가 호출 서버의 IP를 도메인과 별도로 화이트리스트 등록해야 하는 방식**이었습니다(신청서에 서버 IP 추가 등록 후 즉시 해결). API 자체는 `lawSearch.do`(검색, 정의 텍스트 없음)→`lawService.do`(상세, 실제 정의)의 2단계 구조이고, 같은 용어라도 사전구분코드가 `011403`(법령한영사전, 영어 번역만)과 `011402`(법령정의사전, 진짜 정의)로 갈립니다. **1차 시도에서 "성공"으로 표시된 5건 중 3건(임대인·보증금·원상복구)이 실제로는 완전히 무관한 정의였습니다** — 흔한 단어일수록 산림청 장비대여 훈령, 병(용기) 보증금 환불 지침, 지하수법(토양오염 복구) 같은 전혀 다른 목적의 규정에도 같은 단어를 정의해 두고 있어서, "011402 항목이 있으면 채택"이라는 단순 로직이 그 정의를 그대로 주워왔기 때문입니다. 출처(`source`)에 임대차·민법·주택·상가건물·공인중개사 키워드가 없으면 채택하지 않는 관련성 필터를 추가해 재실행한 결과 확정일자·임차인 2건만 남았고, 나머지는 `contract_risk_patterns`처럼 이미 검증된 `legal_provisions` 원문에서 6건을 재활용(`scripts/backfill-legal-terms-from-provisions.mjs`), `target=law`로 주택임대차보호법 전체 조문을 직접 받아 8개 용어를 텍스트 검색한 결과 **"계약갱신청구권"은 법정 명칭이 아니고 실제로는 "계약갱신요구권"(제6조의3②)임을 확인**해 별도 용어로 새로 등록했습니다. **최종적으로 전세가율·특약사항·소액임차인·근저당·임대인·보증금·원상복구·계약갱신청구권 8개는 법제처 법령용어사전에도, 주택임대차보호법 조문 전체 텍스트에도 명시적으로 정의하는 문장이 없음을 직접 확인**했습니다(데이터 누락이 아니라 애초에 그런 조문이 없는 것 — 소액임차인은 시행령, 근저당은 민법 제357조에 있을 가능성이 높아 다음 단계로 남겨둠). 깡통전세·갭투자·전세사기·바지사장 4개는 예상대로 시사 용어라 검색 결과 자체가 없습니다. 이후 `/glossary` 페이지(2026-09-06 추가, 5장 `legal_terms` 참고)가 이 9개를 카드로 보여주고, `Analysis.tsx`도 발견된 유의 조항 텍스트에 이 용어가 나오면 자동으로 링크합니다.
- **2026-09-06 `/law-search`(검증 안 된 실시간 법령 검색) — Edge Function이 법제처 IP 화이트리스트에 막혀 미해결** — `/glossary`가 보여주지 못하는 나머지 용어를 사용자가 직접 실시간 검색해볼 수 있도록 `search-legal-terms` Edge Function을 만들어 `MOLEG_API_OC`를 서버에서만 쓰도록 했으나, 실제 호출해보니 법제처 API가 계속 "사용자 정보 검증에 실패" / "서버장비의 IP주소를 등록해 주세요" 에러를 반환했습니다. 원인을 진단해보니 **Supabase Edge Function은 요청마다 다른 IP로 나갑니다**(실제로 3번 호출해 `3.39.193.82`/`43.200.172.15`/`43.203.250.199` 등 매번 다른 AWS 서울 리전 IP를 확인함) — [Supabase 공식 문서](https://supabase.com/docs/guides/troubleshooting/why-supabase-edge-functions-cannot-provide-static-egress-ips-for-whitelisting-3d78b0)도 Edge Function은 고정 아웃바운드 IP를 제공하지 않으며, IP 화이트리스트가 필요한 외부 API를 호출하려면 고정 IP를 가진 아웃바운드 프록시(자체 VM 또는 QuotaGuard/OutboundGateway 같은 서비스)를 앞에 두라고 안내합니다. 반면 로컬 PC(등록된 고정 IP)에서 직접 호출하는 `scripts/fetch-legal-terms.mjs`/`scripts/backfill-legal-terms-from-provisions.mjs`는 문제없이 동작합니다 — 즉 **법제처 API 자체나 OC 인증의 문제가 아니라, Edge Function이라는 실행 환경 자체가 이 API와 구조적으로 안 맞는 것**입니다. `search-legal-terms` 함수는 배포는 돼 있지만 고정 IP 프록시가 앞에 없는 한 항상 502로 실패합니다.
  - **현재 상태(2026-09-06)**: 인프라(고정 IP 프록시)가 준비되기 전까지 이 기능은 의도적으로 "프론트는 완성, 백엔드만 대기" 상태로 남겨뒀습니다. `/law-search` 페이지(`src/pages/LawSearch.tsx`)는 실제로 만들어져 있고 라우팅(`/law-search`)도 살아 있지만, **TopNav 등 어디에도 링크가 없어 URL을 직접 입력해야만** 들어갈 수 있습니다(`/glossary` 하단의 진입 링크도 아직 렌더링하지 않음) — 사용자가 지금 안 되는 기능에 우연히 들어가지 않도록 하기 위함입니다. 검색어가 `/glossary`의 검증된 9개 용어 중 하나와 일치하면 그 카드를 먼저 보여주고, "검증 안 된 추가 검색 결과 보기" 버튼을 눌러야 실시간 검색이 실행됩니다(일치하지 않으면 바로 실시간 검색). `src/lib/lawSearch.ts`는 `search-legal-terms`를 실제로 호출하고 있어서 지금은 항상 실패하지만, 실패를 그대로 사용자에게 보여주지 않고 **"지금은 이 기능을 이용할 수 없습니다"**로 감싸 보여줍니다 — 실제로 배포된 함수를 호출해 이 실패 경로가 정상적으로 안내 문구를 보여주는 것까지 확인했습니다. 같은 검색어는 `sessionStorage`(`onzip:lawSearchCache`)에 캐싱해 반복 호출을 줄입니다. **고정 IP 프록시만 준비되면 `src/lib/lawSearch.ts`나 `LawSearch.tsx`를 고칠 필요 없이, `/glossary`에 진입 링크만 다시 노출하면 바로 정상 동작합니다.**
- **2026-09-15 `analyze-contract` CPU 타임아웃(546) — 해결됨** — 계약서 이미지 업로드 분석이 간헐적으로 실패한다는 보고가 있어 로그를 보니 8월 28일의 Gemini 502/타임아웃과는 다른 원인인 **Edge Function CPU 시간 제한(2초) 초과(오류 코드 546)**였습니다. 원인은 magick-wasm이 이미지를 "리사이즈하기 전에" 원본 해상도로 먼저 디코드해야 한다는 점 — 서버 쪽 리사이즈 상한(`MAX_DIMENSION_PX`, 당시 2000px)을 아무리 낮춰도, 요즘 폰카메라의 12MP+ 원본을 디코드하는 비용 자체가 이미 제한을 넘었습니다(실측 `cpu_time_used` 3872ms). 서버 상수만 1500px로 낮춰봐도 2183ms로 여전히 546이 나 근본 해결이 안 됐고, **디코드 자체를 원본 해상도로 하지 않게 만들어야** 한다고 결론지었습니다. 조치: ① 브라우저에서 업로드 전에 `createImageBitmap` + canvas로 최대 1200px까지 미리 축소(`src/lib/analyzeContract.ts`), PDF 변환 렌더링 배율도 동일하게 1200px 기준으로 낮춤(`src/lib/pdfToImage.ts`), 서버 `MAX_DIMENSION_PX`도 같은 1200px로 맞춤(`_shared/imageMask.ts`) — 클라이언트·서버 두 상수는 항상 같은 값이어야 한다고 코드 주석에 명시. ② base64 인코딩을 바이트 1개씩 `String.fromCharCode`+문자열 concat 하던 것(이미지 크기에 비례해 CPU를 소모)을 청크(8192바이트) 단위 처리로 바꿔 클라이언트(`analyzeContract.ts`)·서버(`_shared/base64.ts`) 양쪽 다 최적화. ③ magick-wasm 초기화(WASM 컴파일)를 `imageMask.ts`의 `ensureInitialized()`로 명시적으로 export해 `index.ts`가 리사이즈 직전에 먼저 호출하고 `stageTimingsMs.wasmInit`으로 콜드 스타트 시간을 리사이즈 시간과 분리 측정하도록 함(진단 편의). PNG(계약서 스캔/PDF 변환본)는 무손실 유지, 카메라 JPG 사진만 JPEG(품질 0.9)로 재인코딩해 OCR 인식률 저하를 피했습니다.

**코드 품질 — 중복/일관성**
- Gemini 재시도(backoff) 로직이 `analyze-contract`/`analyze-chat`에 동일하게 복사돼 있습니다(공유 모듈로 추출되지 않음).
- 파일→base64 변환 함수, 패턴 점수 색상 임계값(`patternTone`), 위험도 색상 hex 값이 여러 파일에 중복 정의되어 있습니다.
- `analyses.risk_level`(영어)과 `gaslighting_checks`/`region_stats.risk_level`(한글)의 어휘가 다릅니다.
- `/scoring`(`ScoringGuide.tsx`)의 가중치 표는 `_shared/contractScore.ts`/`_shared/riskScore.ts`의 실제 상수를 import하는 게 아니라 값을 그대로 옮겨 적은 별도 상수(`CONTRACT_WEIGHTS`, `MAP_WEIGHTS`)입니다. 두 곳의 상수가 어긋나도 빌드나 타입체크로는 잡히지 않고, 코드 주석으로 "같은 값을 유지해야 한다"고만 남겨둔 상태입니다(6-2 참고).

**성능/UX**
- 프론트에서 파일→base64 변환이 바이트 단위 동기 루프라 큰 파일에서는 메인 스레드가 잠깐 멈출 수 있습니다. 클라이언트 측 파일 크기/타입 검증이 전혀 없습니다.
- 마이페이지 "전체보기"와 홈 화면 뉴스 "더보기"는 실제 페이지네이션이 아니라, 처음에 가져온 목록을 자르고 펼치는 방식입니다.
- 지도의 지역 검색은 순위 없는 단순 부분일치라 여러 지역이 매칭될 수 있는 검색어에서는 사용자가 원하는 결과가 아닐 수 있습니다.
- `Profile.tsx`에서 옛 분석을 다시 열면 HUG 명단 대조 배너가 사라집니다(이력 조회 쿼리가 해당 필드를 아예 선택하지 않기 때문).

**접근 제어**
- `/psych-guard/:id` 조회는 클라이언트 쿼리에 `user_id` 필터가 없어 RLS에만 의존합니다. 확인 결과 RLS 정책 자체는 올바르게 걸려 있어 실제 취약점은 아니지만, 다른 조회 함수 대비 방어 계층이 하나 적습니다.
- `Home`/`Cure`/`SignalMap`/`Analysis`는 비로그인 상태에서도 렌더링되며, 로그인 여부를 확인해 리다이렉트하는 화면은 `Profile.tsx`가 유일합니다.
