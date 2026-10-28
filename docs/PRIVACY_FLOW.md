# 계약서 분석 기능 개인정보 처리 흐름

`analyze-contract` 기능(계약서/등기부등본 이미지 업로드 → AI 위험도 분석)이 개인정보를 어떻게
다루는지 실제 코드를 근거로 정리한 문서. **최초 작성은 2026-08-21 기준 코드 상태를 대상으로 했으며,
모든 설명에는 근거 파일·라인을 함께 표기했다.** 최초 점검은 **CLOVA OCR을 호출하지 않고 코드
리딩만으로** 진행했고, 점검에서 발견된 문제 2건은 같은 날 수정·배포까지 완료했다(수정 검증도
빌드·타입체크로만 확인, 추가 CLOVA 호출 없음). 같은 날 늦게 진행한 후속 점검(로그인 세션 전환
흐름)에서 계약서 분석 결과가 `sessionStorage`를 통해 다음 로그인 사용자에게 남는 문제 1건을 추가로
발견해 함께 수정·배포했다 — 자세한 내용은 [3.2](#32-발견된-문제--수정-완료)의 3번 항목 참고.

> **최종 검증일: 2026-09-18.** 2026-08-21 이후 이 기능과 관련해 실제로 코드가 바뀐 커밋(RAG 키워드
> 필터링·법 조항 연동 2026-08-28, **업로드 이미지 CPU 타임아웃(546) 수정으로 리사이즈 상한
> 2000px→1200px 및 클라이언트 사전 리사이즈 추가 2026-09-15** 등)이 누적되며 이 문서가 인용하는
> 파일:라인 번호 다수가 실제 코드와 어긋나 있었다. 이 날짜에 문서에 나온 모든 파일:라인 인용과
> 코드 스니펫을 실제 파일과 하나씩 대조해 라인 번호·인용 내용을 갱신했다(아래 각주에 무엇이
> 바뀌었는지 표기). 심리 가드(마음 상담, `analyze-chat`)는 이 문서가 다루는 `analyze-contract`
> 범위 밖이라 이번 검증에서 건드리지 않았다 — 관련 내용은 `docs/PROJECT_OVERVIEW.md`의 3-2/6-2절
> 참고.

## 요약

- 업로드된 이미지의 개인정보(주민등록번호·계좌번호·전화번호·임대인/임차인 성명·당사자 개인 주소)는
  **서버에서 CLOVA OCR로 좌표를 읽어 검은 사각형으로 가린 뒤에만** Gemini로 전달된다. 원본 이미지는
  Gemini도, DB도, Storage도 거치지 않는다.
- 임대인 성명은 HUG 명단 조회에만 쓰이고 Gemini에는 애초에 전달되지 않는 별도 경로로 분리돼 있다.
- `analyses` 테이블에는 이미지도, OCR 원문도, 임대인 성명도 저장되지 않는다.
- 발견된 문제 3건은 **전부 수정·배포 완료했다**: ① 분석 결과(임대인 성명 포함)가 클라이언트
  `sessionStorage`에 남는 문제, ② 디버그 전용 경로가 운영 환경에 무방비로 배포돼 있는 문제,
  ③ **로그인 계정을 전환해도 앞사람의 계약서 분석 결과·마음 상담 내용이 `sessionStorage`에 남아
  다음 사용자에게 그대로 보이는 문제**(같은 탭에서 로그아웃 후 다른 계정으로 로그인하는 경우,
  공용 PC에서 특히 위험). 자세한 내용은 [3.2](#32-발견된-문제--수정-완료)의 수정 내역 참고.

## 1. 데이터 흐름 다이어그램

```
[브라우저]
  PDF 선택                                    카메라 사진/이미지 선택
    │ pdf.js로 각 페이지를 canvas에 렌더링       │
    │ → 세로로 이어붙여 PNG 1장으로 변환         │
    │ (src/lib/pdfToImage.ts — 전부 브라우저     │
    │  안에서 처리, 서버로 아무것도 안 감)        │
    ▼                                          ▼
  이미지 파일 (File) ─────────────────────────┘
    │ createImageBitmap + canvas로 최대 1200px로 다운스케일, base64도 청크(8192바이트) 단위로 인코딩
    │ (src/lib/analyzeContract.ts: resizeImageForUpload, blobToBase64 — 2026-09-15 추가, 전부 브라우저 안)
    ▼
  이미지 파일 (다운스케일됨) ── base64 인코딩 ──▶ Supabase Edge Function 호출
  (src/lib/analyzeContract.ts)                          (fileBase64, fileMimeType, address, deposit, buildingType)
                                                                    │
                                                                    ▼
                                            [Supabase Edge Function: analyze-contract]
                                            (supabase/functions/analyze-contract/index.ts)
                                                                    │
                                            ① 이미지 정규화(리사이즈 상한 1200px, PNG 통일) — 이미
                                               브라우저에서 1200px 이하로 줄어 온 이미지라 실제로는
                                               PNG 재인코딩만 하는 경우가 대부분
                                               (_shared/imageMask.ts: prepareImageForOcr)
                                                                    │
                                            ② CLOVA OCR 호출 — 정규화된 이미지 전체(원본 픽셀,
                                               다운스케일만 됨)를 외부로 전송, 텍스트+좌표 응답
                                               (_shared/clovaOcr.ts) ──────▶ [CLOVA OCR API] (외부, 네이버클라우드)
                                                                    │
                                            ③ 마스킹 대상 좌표 판정 (순수 로직, 네트워크 없음)
                                               (_shared/piiMask.ts: findPiiMasks)
                                                                    │
                                            ④ 검은 사각형 마스킹 → 새 이미지 생성
                                               (_shared/imageMask.ts: applyBlackBoxes)
                                                                    │
                                            ⑤ 원본 base64 변수 폐기, 마스킹된 이미지로 교체
                                                                    │
                                            ⑥ Gemini 호출 — "마스킹된 이미지"만 전송
                                               (address/deposit/buildingType 텍스트 + 마스킹 이미지)
                                               ──────▶ [Google Gemini API] (외부, 구글)
                                                                    │
                                            ⑦ 임대인 성명(OCR에서 직접 읽은 값)으로 HUG 명단 조회
                                               (search_hug_defaulters_by_name RPC) ──▶ [Supabase DB]
                                               ※ Gemini 경로와 완전히 분리된 별도 경로
                                                                    │
                                            ⑧ analyses 테이블에 결과 저장 (이미지·OCR원문·임대인
                                               성명 없음) ──▶ [Supabase DB]
                                                                    │
                                                                    ▼
                                            JSON 응답 (분석 결과 + landlordName + HUG 매치 결과)
                                                                    │
                                                                    ▼
                                            [브라우저] Analysis.tsx에 표시, sessionStorage에도 저장
```

## 2. 단계별 상세 설명

### 0단계 — PDF → 이미지 변환 (브라우저, 서버 아님)

- **위치**: [`src/lib/pdfToImage.ts`](../src/lib/pdfToImage.ts) `convertPdfToImage()`
- **데이터 이동**: 없음 — 전부 브라우저 안에서 끝난다. pdf.js가 각 페이지를 `<canvas>`에
  렌더링하고([pdfToImage.ts:51-59](../src/lib/pdfToImage.ts#L51-L59)), 캔버스들을 세로로 이어붙여
  ([pdfToImage.ts:73-77](../src/lib/pdfToImage.ts#L73-L77)) PNG `Blob` 하나로 변환한다
  ([pdfToImage.ts:79-84](../src/lib/pdfToImage.ts#L79-L84)).
- **개인정보 포함 여부**: 원본 PDF 내용이 그대로 이미지 픽셀로 옮겨질 뿐, 이 단계에서 서버로 나가는
  바이트는 하나도 없다.
- **PDF는 어디서 이미지로 바뀌는가**: **클라이언트(브라우저)**. 서버는 PDF를 아예 받지 않는다
  ([index.ts:462-464](../supabase/functions/analyze-contract/index.ts#L462-L464)에서
  `image/jpeg`·`image/png`가 아니면 즉시 400 에러).

### 0-1단계 — 업로드 전 리사이즈 + base64 인코딩 (브라우저, 2026-09-15 추가)

- **위치**: [`src/lib/analyzeContract.ts`](../src/lib/analyzeContract.ts) `resizeImageForUpload()`
  ([analyzeContract.ts:98-127](../src/lib/analyzeContract.ts#L98-L127)), `blobToBase64()`
  ([analyzeContract.ts:133-141](../src/lib/analyzeContract.ts#L133-L141)), 호출부는
  [analyzeContract.ts:159-163](../src/lib/analyzeContract.ts#L159-L163).
- **왜 추가됐는가**: 카메라로 찍은 사진은 원본 해상도(요즘 폰 12MP 이상) 그대로 들어오는데, 리사이즈
  없이 서버로 보내면 서버(magick-wasm)가 리사이즈를 하기 "전에" 원본 해상도로 먼저 디코드해야 해서
  Edge Function CPU 시간 제한(2초)을 초과했다(실측 `cpu_time_used` 3872ms, 오류 546). 브라우저는 이
  제한이 없으므로 다운스케일을 여기서 먼저 끝내 서버가 항상 작은 이미지만 받도록 바꿨다.
- **데이터 이동**: 없음 — 전부 브라우저 안에서 끝난다(`createImageBitmap` + `<canvas>`로 리사이즈,
  `canvas.toBlob()`으로 인코딩). 서버로는 최종 결과물만 전송된다.
- **처리 내용**: 긴 변이 `MAX_UPLOAD_DIMENSION_PX`(1200px, 서버의 `imageMask.ts`
  `MAX_DIMENSION_PX`와 반드시 같은 값으로 맞춰야 한다고 주석에 명시)를 넘으면 비율을 유지해 축소한다.
  PNG(계약서 스캔·PDF 변환본, 무손실)는 PNG로 유지하고, 카메라 JPG 사진만 JPEG(품질 0.9)로
  재인코딩한다(문서 스캔까지 매번 JPEG로 바꾸면 압축 손실로 OCR 인식률이 떨어질 수 있어서). base64
  인코딩도 바이트 1개씩이 아니라 8192바이트 청크 단위로 처리해(`BASE64_CHUNK_SIZE`,
  [analyzeContract.ts:131](../src/lib/analyzeContract.ts#L131)) 큰 이미지에서 메인 스레드가 오래
  묶이는 것을 줄였다.
- **개인정보 포함 여부**: 이 단계는 순수 화질/인코딩 변환이라 내용(텍스트)은 원본과 동일하다 — 이
  단계에서 아무것도 가려지지 않으며, 이미지는 여전히 브라우저 밖으로 나가지 않는다.

### 1단계 — 요청 수신 및 검증

- **위치**: [`src/lib/analyzeContract.ts`](../src/lib/analyzeContract.ts) `analyzeContract()` →
  [`index.ts:423-464`](../supabase/functions/analyze-contract/index.ts#L423-L464)
- **데이터 이동**: 브라우저 → Supabase Edge Function. `fileBase64`(0-1단계에서 리사이즈·인코딩된
  이미지의 base64), `fileMimeType`, `address`, `deposit`, `buildingType`를 JSON으로 전송.
- **개인정보 포함 여부**: 이 시점의 `fileBase64`는 **아직 마스킹되지 않은 이미지**다(0-1단계에서
  화질만 축소됐을 뿐 계약서 내용은 원본과 동일하게 그대로 들어있다). 다만 이건 사용자 본인이 자신의
  문서를 분석 서버로 보내는 정상적인 흐름이다(제3자 유출 아님).

### 2단계 — 이미지 정규화(리사이즈)

- **위치**: [`_shared/imageMask.ts`](../supabase/functions/_shared/imageMask.ts) `prepareImageForOcr()`
  ([index.ts:482-490](../supabase/functions/analyze-contract/index.ts#L482-L490)에서 호출). 이 호출
  직전에 magick-wasm 초기화(WASM 컴파일)를 콜드 스타트 시간 측정 목적으로 먼저
  호출한다([index.ts:470-477](../supabase/functions/analyze-contract/index.ts#L470-L477),
  `ensureInitialized()` — 2026-09-15부터 `imageMask.ts`의 named export로 분리됨). 데이터 이동이나
  PII 처리와는 무관한 순수 타이밍 계측용 변경이다.
- **데이터 이동**: 서버 메모리 안에서만 처리(magick-wasm). 외부로 나가지 않음.
- **CLOVA에 보내는 이미지는 원본인가 리사이즈본인가**: **리사이즈본**. 긴 변이 **1200px**(2026-09-15
  이전에는 2000px였다가, CPU 타임아웃 문제로 하향)를 넘으면 축소하고, 넘지 않아도 항상 PNG로 다시
  인코딩한다([imageMask.ts:77](../supabase/functions/_shared/imageMask.ts#L77)의
  `MAX_DIMENSION_PX` 상수, 리사이즈 로직은
  [imageMask.ts:82-99](../supabase/functions/_shared/imageMask.ts#L82-L99)). 0-1단계에서 브라우저가
  이미 같은 1200px 기준으로 축소해 보내므로, 실제로 이 서버 단계에서 다시 축소되는 경우는 드물고
  대부분 PNG 재인코딩만 일어난다. **화질만 조정될 뿐 내용(텍스트)은 원본과 동일** — 이 단계에서
  아무것도 가려지지 않는다. 실패하면 분석을 즉시 중단한다([index.ts:487-490](../supabase/functions/analyze-contract/index.ts#L487-L490)).

### 3단계 — CLOVA OCR 호출 (이 시점에 이미지가 처음 외부로 나감)

- **위치**: [`_shared/clovaOcr.ts`](../supabase/functions/_shared/clovaOcr.ts) `runClovaOcr()`
  ([index.ts:492-500](../supabase/functions/analyze-contract/index.ts#L492-L500)에서 호출)
- **데이터 이동**: Supabase Edge Function → **CLOVA OCR API(네이버클라우드, 외부)**.
  [clovaOcr.ts:31-44](../supabase/functions/_shared/clovaOcr.ts#L31-L44)에서 2단계의 리사이즈된
  이미지 전체(base64)를 `X-OCR-SECRET` 헤더와 함께 전송하고, 텍스트(`inferText`)와 좌표
  (`boundingPoly.vertices`)를 응답으로 받는다.
- **개인정보 포함 여부**: **이 호출에 실리는 이미지에는 개인정보가 아직 그대로 들어있다.** 이건
  구조적으로 피할 수 없다 — 어디를 가릴지 알려면 먼저 OCR로 텍스트 좌표를 읽어야 하기 때문. CLOVA는
  네이버클라우드가 운영하는 외부 API이므로, 이미지가 우리 서버 밖으로 나가는 유일한 지점이다(자세한
  내용은 [4장 한계](#4-남아있는-한계) 참고). 실패 시(네트워크 오류, 응답 형식 이상 등) 예외를
  던지고 호출부가 분석을 즉시 중단한다([clovaOcr.ts:49-57](../supabase/functions/_shared/clovaOcr.ts#L49-L57)).

### 4단계 — 마스킹 대상 좌표 판정 (순수 로직, 네트워크 없음)

- **위치**: [`_shared/piiMask.ts`](../supabase/functions/_shared/piiMask.ts) `findPiiMasks()`
- **데이터 이동**: 없음. CLOVA 응답(텍스트+좌표 배열)을 받아 로컬에서 계산만 한다.

**정규식 판정 (숫자형 PII)** — [piiMask.ts:36-108](../supabase/functions/_shared/piiMask.ts#L36-L108):

| 항목 | 패턴 | 비고 |
|---|---|---|
| 주민등록번호 | `\d{6}[-\s]?\d{7}` | 필드 하나로도, 공백으로 나뉜 인접 두 필드를 이어붙여도 검사 |
| 계좌번호 | `\d{2,6}-\d{2,6}-\d{2,8}` | `YYYY-MM-DD` 형태 날짜는 별도로 걸러내 계약기간과 구분 |
| 전화번호 | `01[016789][-\s]?\d{3,4}[-\s]?\d{4}` 또는 지역번호+국번+번호 | 휴대폰/유선 둘 다 |

**라벨 매칭 (이름/주소)** — [piiMask.ts:57-121](../supabase/functions/_shared/piiMask.ts#L57-L121):
라벨 5종(`임대인`/`임차인`/`성명`/`영수자`/`주소`)을 정의해두고, OCR 필드 텍스트가 해당 라벨로
`시작`하면서 그 뒤에 장식(빈 문자열/갑/을/성명/서명/인)만 붙어 있을 때만 "폼 라벨"로 인정한다
(`matchLabel`, [piiMask.ts:113-121](../supabase/functions/_shared/piiMask.ts#L113-L121)). 라벨로
인정되면, 같은 줄에서 라벨보다 오른쪽에 있는 필드들을 "값"으로 보고 마스킹 후보로 모은다.
`소재지`(매물 주소)는 라벨 목록에 없어 절대 매칭되지 않는다 — 상단 매물 정보와 하단 당사자 개인
정보를 라벨 단어 자체로 구분하는 방식이다.

**방어 조건 3가지** — 후보를 실제로 마스킹하기 전에 아래 3가지를 모두 통과해야 한다
([piiMask.ts:195-200](../supabase/functions/_shared/piiMask.ts#L195-L200)). 하나라도 걸리면 그
라벨 매칭은 통째로 무시되고(부분적으로도 마스킹하지 않음), 조항 본문으로 간주한다:

1. **후보 개수 상한** — 라벨 뒤 같은 줄에 있는 값 후보가 0개이거나, 라벨 유형별 상한(이름류
   3개, 주소 8개)을 넘으면 스킵. 이름은 보통 1~2토큰, 주소는 시/구/동/번지로 여러 토큰이라 상한을
   다르게 뒀다.
2. **접속사/조사 검사** — 값 후보의 첫 토큰이 `또는·그리고·은·는·이·가·을·를·의` 등 접속사/조사
   목록에 있으면 토큰 개수와 무관하게 스킵. ("임대인 또는 임차인이 …" 같은 조항 본문 방지)
3. **총 글자수 상한** — 값 후보들의 글자수 합이 라벨 유형별 상한(이름류 20자, 주소 40자)을
   넘으면 스킵.

이 3가지는 실제로 발견된 오탐(조항 본문 "제7조 (채무불이행과 손해배상) 임대인 또는 임차인이 …"가
통째로 마스킹된 사고)을 막기 위해 추가된 것이다.

- **개인정보 포함 여부**: 함수의 반환값(`boxes`, `landlordName`, `stats`) 중 `boxes`는 좌표 숫자
  뿐이고, `stats`는 유형별 개수만 담는 구조여서 원문 텍스트를 담을 수 없다
  ([piiMask.ts:13-14](../supabase/functions/_shared/piiMask.ts#L13-L14) 주석 참고). **`landlordName`
  만 유일하게 실제 이름 문자열을 담는 반환값**이며, 이건 5단계 이후 HUG 조회 전용으로만 쓰인다.

### 5단계 — 이미지 마스킹

- **위치**: [`_shared/imageMask.ts`](../supabase/functions/_shared/imageMask.ts) `applyBlackBoxes()`
  ([index.ts:520-534](../supabase/functions/analyze-contract/index.ts#L520-L534)에서 호출)
- **데이터 이동**: 서버 메모리 안에서만. `boxes` 좌표에 magick-wasm으로 검은 사각형을 그려 새
  PNG를 만든다([imageMask.ts:49-64](../supabase/functions/_shared/imageMask.ts#L49-L64)).
  `boxes`가 비어 있어도(가릴 게 없어도) 반드시 이 함수를 거치게 해 "마스킹 단계 스킵" 상태가
  생기지 않도록 설계했다. 실패하면 예외를 던지고 분석을 중단한다.
- **개인정보 포함 여부**: 입력은 원본 그대로지만, 출력(`maskedImageBase64`)에서는 4단계가 찾아낸
  영역이 전부 검게 덮인 상태다.

### 6단계 — 원본 폐기 및 Gemini 전송

- **위치**: 원본 덮어쓰기는 [index.ts:536-540](../supabase/functions/analyze-contract/index.ts#L536-L540),
  Gemini 호출은 [index.ts:576-579](../supabase/functions/analyze-contract/index.ts#L576-L579) —
  2026-08-28 RAG 키워드 필터링·법 조항 연동이 추가되며 두 코드가 더 이상 바로 이어져 있지 않고
  그 사이(544-574줄)에 `contract_risk_patterns`/`legal_provisions` 조회 코드가 끼어들었다(개인정보와
  무관한 일반 지식 데이터라 이 단계 설명 자체는 달라지지 않는다).
- **데이터 이동**: `input.fileBase64`를 마스킹된 이미지로 **덮어쓴다**
  ([index.ts:538](../supabase/functions/analyze-contract/index.ts#L538)) — 이 시점부터 원본
  base64 문자열은 `input` 객체 어디에서도 더 이상 참조되지 않는다(다른 변수에도 복사해두지 않았음,
  GC 대상이 됨). 이후 Supabase Edge Function → **Google Gemini API(외부)**로 전송.
- **Gemini에 최종적으로 전달되는 데이터**: `buildPrompt()`가 만든 텍스트 프롬프트(매물
  주소/보증금/건물유형 + `contract_risk_patterns` 참고 사례 + 관련 법 조항 후보 — 전부 사용자가
  입력했거나 사전에 DB에 있는 일반 지식, 개인정보 아님) **+ 마스킹된 이미지 1장**([index.ts:576-579](../supabase/functions/analyze-contract/index.ts#L576-L579)).
  파일이 없으면(주소만으로 분석하는 경우) 이미지 파트 자체가 생략된다. **원본 이미지, OCR
  원문, 임대인 성명 중 어느 것도 Gemini로 가지 않는다** — `landlordName`은 스키마에서 아예
  빠져 있다([index.ts:137-138](../supabase/functions/analyze-contract/index.ts#L137-L138) 주석,
  스키마 `properties`에 필드 없음). 프롬프트 지침 7번이 "일부 영역이 가려져 있으니 추측하지
  말라"고 Gemini에 명시한다([index.ts:243](../supabase/functions/analyze-contract/index.ts#L243)).

### 7단계 — HUG 명단 조회 (Gemini와 완전히 분리된 경로)

- **위치**: [index.ts:666-679](../supabase/functions/analyze-contract/index.ts#L666-L679)
- **데이터 이동**: Supabase Edge Function → Supabase DB (`search_hug_defaulters_by_name` RPC,
  [20260721000004_add_hug_defaulter_name_search.sql](../supabase/migrations/20260721000004_add_hug_defaulter_name_search.sql)).
- **경로 분리**: `landlordNameFromOcr`(4단계에서 CLOVA OCR로 직접 읽은 값, **Gemini 응답이 아님**)를
  그대로 이 RPC의 인자로 넘긴다([index.ts:668-672](../supabase/functions/analyze-contract/index.ts#L668-L672)).
  즉 "임대인 이름을 안다"는 사실 자체가 OCR → HUG 조회로 가는 한 갈래와, OCR → 마스킹 → Gemini로
  가는(이름은 안 보이는) 다른 한 갈래로 처음부터 나뉘어 있고, 둘이 다시 합쳐지는 지점은 없다.
  RPC 함수 자체도 조회만 하는 순수 SQL이라 조회한 이름을 별도로 기록하지 않는다
  ([20260721000004_add_hug_defaulter_name_search.sql:3-15](../supabase/migrations/20260721000004_add_hug_defaulter_name_search.sql#L3-L15)).

### 8단계 — DB 저장

- **위치**: [index.ts:682-694](../supabase/functions/analyze-contract/index.ts#L682-L694),
  테이블 정의는 [20260718010000_create_analyses_table.sql](../supabase/migrations/20260718010000_create_analyses_table.sql)
- **저장되는 컬럼**: `user_id, address, deposit, building_type, overall_score, risk_level,
  categories, detected_clauses, recommended_actions, ai_comment, created_at` — **이미지, OCR 원문,
  landlordName, hugDefaulterMatch 중 어느 것도 저장되지 않는다.** (자세한 검토는
  [3.1](#31-문제없음)의 DB 점검 참고)

### 9단계 — 클라이언트 응답 및 표시

- **위치**: [index.ts:703](../supabase/functions/analyze-contract/index.ts#L703) → [`src/pages/Analysis.tsx`](../src/pages/Analysis.tsx)
- **데이터 이동**: Supabase Edge Function → 브라우저. `result`(Gemini 결과 + 주입된 `landlordName`
  + `hugDefaulterMatch`)를 그대로 JSON으로 반환.
- **개인정보 포함 여부**: `landlordName`이 응답에 포함된다 — 사용자 본인이 올린 자기 계약서의
  임대인 이름을 화면에 보여주는 것 자체는 정상 기능이다. 이 값이 `sessionStorage`에 남던 문제는
  [3.2](#32-발견된-문제--수정-완료)에서 다루며, 수정 완료 상태다.

## 3. 점검 결과

### 3.1 문제없음

- **DB 저장** — `analyses` insert 컬럼 전수 확인([index.ts:683-694](../supabase/functions/analyze-contract/index.ts#L683-L694)):
  이미지·OCR 원문·`landlordName`·HUG 매치 결과 어느 것도 포함되지 않음. `categories`/`detected_clauses`는
  Gemini가 **마스킹된 이미지만 보고** 생성한 값이라 구조적으로 원본 PII를 담을 수 없다(가려진
  픽셀은 Gemini도 못 읽는다).
- **서버 로그** — `analyze-contract`와 `_shared/*` 전체의 `console.log`/`console.error` 호출을
  전수 확인. OCR 필드 배열(`ocrFields`)이나 필드 텍스트(`.text`)를 직접 찍는 곳은 없음. 유일하게
  구조화된 값을 찍는 곳은 `stats`([index.ts:518](../supabase/functions/analyze-contract/index.ts#L518))이며,
  이 타입은 전부 숫자 필드라 문자열(이름/번호)이 애초에 들어갈 수 없음
  ([piiMask.ts:15-27](../supabase/functions/_shared/piiMask.ts#L15-L27)). `landlordNameFromOcr`가
  로그에 찍히는 곳은 전무.
- **에러 응답** — `jsonResponse(...)` 호출 전수 확인. 전부 하드코딩된 고정 한국어 문자열이거나 최종
  `result`(Gemini 결과) 뿐. `err.message`나 CLOVA 응답 바디가 클라이언트 응답에 섞이는 경로는 없음.
  (`debugMask` 응답도 있었으나 3.2의 수정으로 완전히 제거됨.)
- **원본 이미지 잔존 여부** — Storage 버킷 사용 없음(`supabase/config.toml`의
  `[storage.buckets.*]`는 전부 주석 처리된 기본 스캐폴드). 원본 base64는 `input.fileBase64`
  재할당([index.ts:538](../supabase/functions/analyze-contract/index.ts#L538))으로 더 이상
  참조되지 않고, 별도 변수에 복사해두지도 않았다.
- **클라이언트 원본 이미지/PDF 잔존 여부** — `Home.tsx`의 `file`/`address`/`deposit` 등은 전부
  일반 `useState`(컴포넌트 언마운트 시 소멸, `localStorage`/`sessionStorage` 미사용, 2026-09-18
  재확인). 세션스토리지를 쓰는 `useSessionState` 훅은 [`Cure.tsx`](../src/pages/Cure.tsx)(AI 상담
  채팅)에서만 쓰이고 계약서 분석 플로우와는 무관함을 재확인.
- **마케팅 문구 검증** — [Home.tsx:310-312](../src/pages/Home.tsx#L310-L312)의 "업로드한 계약서는
  분석 후 안전하게 삭제됩니다"는 정확히는 "애초에 저장하지 않는다"이며, 실제 코드 동작과 일치함.
- **HUG 명단 조회 권한** — `search_hug_defaulters_by_name` RPC가 `anon`에도 EXECUTE 권한이 있는 건
  처음엔 의심했지만, `hug_defaulters` 테이블의 RLS 정책 자체가 "공개 명단이므로 조회는 누구나
  가능해야 한다"며 이미 `anon`에게 전체 공개돼 있었다(의도된 설계). 자세한 근거는 3.3 참고.

### 3.2 발견된 문제 — 수정 완료

1. **`landlordName`이 브라우저 `sessionStorage`에 평문 저장됨. → 수정 완료.**
   기존 문제: `navState`(Gemini 응답 + 주입된 `landlordName`)를 통째로
   `sessionStorage.setItem('onzip:lastAnalysis', JSON.stringify(navState))`로 저장하고 있었다.
   탭을 닫으면 사라지고 서버로 다시 전송되진 않지만, 탭이 열려 있는 동안은 같은 오리진의 다른
   스크립트(XSS 발생 시)나 공용 PC의 다음 사용자가 개발자도구(Application → Session Storage)로
   그대로 열람할 수 있었다.
   조사해보니 `landlordName`은 실제로 화면 표시에 쓰이고 있었다 — HUG 매치 경고 배너에서
   "계약서에서 확인된 임대인 "[이름]"과(와)…" 문구에 이름을 그대로 넣어, 사용자가 OCR이 제대로
   읽었는지·명단 매치가 실제로 자기 계약서 속 그 이름과 관련된 것인지 확인할 수 있게 해주는
   용도였다. 그래서 완전 삭제 대신 다음과
   같이 분리했다: 방금 분석을 마치고 넘어온 화면(React Router의 `location.state`, 메모리에만 존재)은
   `landlordName`을 그대로 갖고 있어 배너 문구가 정상 표시되고, **`sessionStorage`에 쓰기 직전에만
   `landlordName`을 제외**한다([Analysis.tsx:82-93](../src/pages/Analysis.tsx#L82-L93), 특히
   제외 자체는 [Analysis.tsx:87-89](../src/pages/Analysis.tsx#L87-L89)). 페이지를
   새로고침하거나 나중에 다시 방문해 `sessionStorage`에서 복원되는 경우엔 `landlordName`이 없으므로
   배너 문구가 "계약서에서 확인된 임대인 이름과 유사한 인물이…"로 일반화된다([Analysis.tsx:147-155](../src/pages/Analysis.tsx#L147-L155)) —
   일치 여부·경고·매치 목록(공개 HUG 데이터)은 그대로 보이고 실명만 빠진다. `sessionStorage`에는
   이제 `landlordName`이 어떤 경로로도 들어가지 않는다.

2. **`debugMask` 디버그 경로가 운영 환경에 무방비로 배포돼 있음. → 수정 완료(코드 삭제 + 재배포).**
   기존 문제: `if (input.debugMask) { return jsonResponse({ maskedImageBase64, stats }) }`가 환경
   구분이나 추가 인증 없이, 공개된 anon key만 있으면 누구나 호출할 수 있는 상태로 운영 프로젝트에
   배포돼 있었다. 호출자가 자신의 이미지를 올려야 하므로 다른 사용자의 데이터가 새는 것은 아니었지만,
   (a) 마스킹 로직을 무료로 반복 프로빙해 회피 패턴을 찾아낼 수 있고, (b) 제3자가 CLOVA 무료 한도
   (월 100회)를 소진시킬 수 있는 경로였다. 실제 계약서 검증이 끝나 더 이상 필요 없어져, `debugMask`
   필드·분기(`analyze-contract/index.ts`), `debugMaskContract`/`DebugMaskResult`(`analyzeContract.ts`),
   미리보기 버튼·상태·핸들러(`Home.tsx`)를 전부 삭제하고 `analyze-contract`를 재배포해 운영에서도
   막았다. `Uint8Array.from()` 메모리 복사 수정(같은 시기에 발견된 별개의 실제 버그)은 `debugMask`와
   무관한 영구 수정이라 그대로 남겨뒀다.

3. **계정을 전환해도 앞사람의 분석 결과·상담 내용이 `sessionStorage`에 남아 다음 사용자에게 노출됨.
   → 수정 완료(`src/lib/sessionCleanup.ts` 추가).**
   기존 문제: 계약서 분석 결과(`onzip:lastAnalysis`)와 마음 상담 대화(`onzip:psychGuardMessages`)는
   `sessionStorage`에 저장되는데, `sessionStorage`는 로그인 상태와 무관하게 **탭이 살아있는 동안
   계속 유지**된다. 같은 탭에서 A가 로그아웃하고 B가 로그인하면, B의 화면(혹은 개발자도구)에 A가
   방금 분석한 계약서 위험 조항·매물 주소·보증금이나 A가 붙여넣은 문자/카톡 상담 내용이 그대로
   남아 있었다. 비로그인 상태로 분석한 뒤 로그인하는 경우도 마찬가지였다 — 공용 PC에서 앞사람이
   로그인 없이 분석해 둔 내용을 뒷사람이 그대로 보는 경로였다.
   조치: `src/lib/sessionCleanup.ts`의 `registerSessionCleanup()`을 `src/main.tsx`에서 앱 렌더링
   전에 한 번 등록해, `supabase.auth.onAuthStateChange`로 로그인 세션의 소유자(사용자 id, 비로그인은
   `'anon'`)가 바뀔 때마다 `onzip:lastAnalysis`/`onzip:psychGuardMessages`를 지운다. 소유자를
   `sessionStorage`의 `onzip:sessionOwner` 키에 함께 기록해 "바뀐 경우"만 판별하므로, 같은 사용자의
   새로고침이나 토큰 자동 갱신으로는 보고 있던 결과가 사라지지 않는다. Supabase Auth 자체 세션은
   `localStorage`에 별도로 저장되고 `signOut()`이 알아서 정리하므로 이 정리 대상에는 포함하지
   않았다.

### 3.3 개선 필요 (당장 위험하진 않지만 손봐두면 좋은 것)

1. **CLOVA 에러 응답 바디 최대 300자가 서버 로그에 남을 수 있음.**
   [clovaOcr.ts:50](../supabase/functions/_shared/clovaOcr.ts#L50)에서
   `res.text()`의 앞 300자를 그대로 `Error` 메시지에 넣고, 이게 `console.error`로 로그에 남는다
   ([index.ts:498](../supabase/functions/analyze-contract/index.ts#L498)). 지금까지 실제로 관찰된
   CLOVA 에러 응답은 `{code, message, path, traceId, timestamp}` 형태의 API 메타데이터뿐이라 PII가
   섞인 적은 없지만, 이건 CLOVA가 앞으로도 그럴 것이라는 우리 코드의 구조적 보장이 아니라 관찰에
   근거한 판단이다. (참고: 이 값은 클라이언트 응답에는 절대 안 나감 — 3.1 참고. 서버 로그는 Supabase
   프로젝트 소유자만 볼 수 있는 비공개 영역이라 "유출"보다는 "불필요한 보관"에 가깝다.)

> `search_hug_defaulters_by_name` RPC가 `anon` role에도 EXECUTE 권한이 있는 점도 처음엔 문제로
> 의심했지만, `hug_defaulters` 테이블 자체의 RLS 정책이 이미 `"Anyone can search hug defaulters"
> ... to anon, authenticated using (true)`로 **의도적으로 전체 공개**돼 있었다
> ([20260721000001_create_hug_defaulters.sql:31-36](../supabase/migrations/20260721000001_create_hug_defaulters.sql#L31-L36),
> 주석: "공개 명단이므로 조회는 누구나 가능해야 한다 — 계약 전 확인이 핵심 기능"). 즉 RPC의 `anon`
> 권한은 이미 열려 있는 접근을 확장하는 게 아니라 같은 설계와 중복될 뿐이라 실질적인 추가 노출이
> 아니다 — 점검해보니 문제가 아니어서 3.1(문제없음)로 재분류한다.

## 4. 남아있는 한계

- **CLOVA OCR은 외부 API라, 이미지가 한 번은 반드시 외부로 나간다.** 마스킹할 위치를 알려면 먼저
  OCR로 좌표를 읽어야 하므로, 원본(리사이즈만 된) 이미지 전체가 네이버클라우드의 CLOVA OCR
  엔드포인트로 전송되는 것은 구조적으로 피할 수 없다. CLOVA 측의 데이터 보관/처리 정책은 이 코드베이스가
  통제할 수 있는 범위 밖이다.
- **매물 주소·보증금은 Google Gemini API(외부)로 전송된다.** 이건 위험도 분석의 핵심 입력이라
  의도적으로 마스킹 대상에서 제외했다(요청사항). 매물 주소 자체는 계약 상대방을 특정하는 정보는
  아니지만, 외부 LLM API로 나간다는 사실은 명시해둔다.
  Google의 API 데이터 처리 정책 역시 이 코드베이스 밖의 영역이다.
- **마스킹은 OCR과 규칙 기반 판정에 의존하므로 완벽하지 않다.** 지금까지 실제 표준임대차계약서로
  테스트하며 라벨 오탐(조항 본문 오마스킹) 2건, 미탐(성명 라벨, 개인 주소) 2건을 발견해 고쳤다.
  구조는 "OCR 실패·필드 0개·마스킹 자체 실패 시 분석을 중단"하는 방식으로 fail-safe하게 설계했지만
  (다시 말해 "실패를 알아채면" 확실히 막지만), **아직 발견되지 않은 다른 라벨 패턴이나 문서 양식에서
  또 다른 미탐/오탐이 존재할 가능성은 배제할 수 없다.**
- **CLOVA 에러 응답 일부(최대 300자)가 서버 로그에 남을 수 있다** — [3.3-1](#33-개선-필요-당장-위험하진-않지만-손봐두면-좋은-것) 참고.
