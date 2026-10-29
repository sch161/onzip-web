import {
  useEffect,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import AnalyzingOverlay from "../components/ui/AnalyzingOverlay";
import BrokenText from "../components/ui/BrokenText";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import { analyzeContract } from "../lib/analyzeContract";
import { fetchLatestNews, type NewsItem } from "../lib/news";
import { convertPdfToImage } from "../lib/pdfToImage";

function formatNewsDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value;
}

const TRUST_FACTS = [
  {
    icon: "sparkles",
    title: "Google Gemini AI 분석",
    body: "실제 AI 모델이 계약서 조항을 직접 읽고 위험 요소를 짚어드려요.",
  },
  {
    icon: "shield-check",
    title: "HUG 공식 데이터 대조",
    body: "주택도시보증공사 상습 채무불이행자 명단과 임대인 정보를 대조해요.",
  },
  {
    icon: "chart-no-axes-combined",
    title: "국토교통부 실거래가 기반",
    body: "공식 실거래가 통계로 지역별 전세가율과 위험도를 계산해요.",
  },
];

const NEWS_PAGE_SIZE = 3;

// 서버가 업로드된 이미지를 OCR 전에 자동으로 축소하므로 사진 해상도 자체는 걱정하지 않아도 되지만,
// 네트워크 전송량을 위해 과도하게 큰 파일(예: 잘못 선택한 동영상)은 업로드 전에 걸러낸다.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const FEATURES = [
  {
    icon: "file-search",
    title: "계약서 위험 조항 탐지",
    body: "보증금 미반환, 불리한 특약, 등기부 위험까지 조항 단위로 짚어드려요.",
  },
  {
    icon: "map-pin-house",
    title: "지역별 주거 위험도",
    body: "전세가율, 사고 이력, 시세 흐름을 지도 위에서 한눈에 비교하세요.",
  },
  {
    icon: "heart-handshake",
    title: "마음까지 돌보는 상담",
    body: "낯선 도시살이의 불안, AI 상담 도우미와 편하게 이야기 나눠요.",
  },
];

export default function Home() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [address, setAddress] = useState("");
  const [deposit, setDeposit] = useState("");
  const [buildingType, setBuildingType] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [newsExpanded, setNewsExpanded] = useState(false);
  const [pdfConverting, setPdfConverting] = useState(false);
  const [pdfPageWarning, setPdfPageWarning] = useState<string | null>(null);

  useEffect(() => {
    fetchLatestNews(12)
      .then(setNewsItems)
      .catch((err) =>
        setNewsError(
          err instanceof Error ? err.message : "뉴스를 불러오지 못했습니다.",
        ),
      )
      .finally(() => setNewsLoading(false));
  }, []);

  async function selectFile(candidate: File | null) {
    if (!candidate) return;
    if (candidate.size > MAX_UPLOAD_BYTES) {
      setError(
        `파일이 너무 큽니다. ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB 이하로 올려주세요.`,
      );
      return;
    }
    setError(null);
    setPdfPageWarning(null);

    const isPdf =
      candidate.type === "application/pdf" ||
      candidate.name.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      setFile(candidate);
      return;
    }

    setPdfConverting(true);
    setFile(null);
    try {
      const converted = await convertPdfToImage(candidate);
      if (converted.file.size > MAX_UPLOAD_BYTES) {
        setError("변환된 이미지가 너무 큽니다. 더 짧은 PDF로 다시 시도해주세요.");
        return;
      }
      setFile(converted.file);
      if (converted.isLowRes) {
        setPdfPageWarning(
          `페이지가 많아(${converted.pageCount}쪽) 일부 작은 글씨의 인식률이 떨어질 수 있어요.`,
        );
      }
    } catch (err) {
      console.error("PDF conversion failed", err);
      setError("이 PDF는 처리할 수 없습니다. 사진으로 찍어서 올려주세요.");
    } finally {
      setPdfConverting(false);
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    void selectFile(e.target.files?.[0] ?? null);
  }

  function handleDragOver(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setIsDragging(false);
    void selectFile(e.dataTransfer.files?.[0] ?? null);
  }

  async function handleAnalyze(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await analyzeContract({
        address,
        deposit,
        buildingType,
        file: file ?? undefined,
      });
      navigate("/analysis", { state: { result } });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "분석 중 오류가 발생했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-8 px-5 pt-6 pb-4 lg:mx-auto lg:max-w-[1040px] lg:gap-14 lg:px-6 lg:pb-16 lg:pt-10">
      {loading && <AnalyzingOverlay />}

      <header className="lg:hidden">
        <h1 className="text-lg font-bold text-primary">계약서 분석</h1>
        <p className="mt-1 text-xs text-text-gray">
          계약 전에, 위험을 먼저 확인하세요
        </p>
      </header>

      <section className="grid gap-8 lg:grid-cols-[1fr_1.06fr] lg:items-center lg:gap-12">
        <div className="hidden lg:block">
          <div className="mb-5 inline-flex items-center gap-[7px] rounded-chip bg-primary-bg px-3.5 py-[7px] text-[13px] font-bold text-primary-dark">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            상경 청년을 위한 안심 주거 파트너
          </div>
          <h2 className="text-balance text-[42px] font-extrabold leading-[1.15] tracking-tight text-text-dark">
            계약 전에,
            <br />
            위험을 먼저 확인하세요
          </h2>
          <p className="mt-5 max-w-[440px] text-[17px] leading-relaxed text-text-gray">
            AI가 부동산 계약서의 위험 요소를 꼼꼼히 분석하고,
            <br />
            살고 싶은 동네의 주거 위험도까지 알려드려요.
            <br />
            처음 서울 살이, 이제 혼자 걱정하지 마세요.
          </p>
          <div className="mt-8 flex flex-col gap-3">
            {TRUST_FACTS.map((fact) => (
              <div key={fact.title} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-primary">
                  <span className="flex h-5 w-5 items-center justify-center"><img src={`/icons/home/${fact.icon}.svg`} alt="" aria-hidden="true" className="max-w-none scale-125" /></span>
                </span>
                <p className="text-[13.5px] leading-relaxed text-text-gray">
                  <span className="font-bold text-text-dark">{fact.title}</span>
                  <br />
                  {fact.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        <Card className="flex flex-col gap-4 lg:p-[30px]">
          <div>
            <p className="mt-1 text-[11px] leading-relaxed text-text-gray">
              <BrokenText text="등기부등본이나 계약서를 업로드하면 AI가 위험 조항을 자동으로 찾아드려요." />
            </p>
          </div>

          <label
            htmlFor="scan-upload"
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`flex h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-[1.5px] border-dashed text-center transition-colors ${
              isDragging
                ? "border-primary bg-primary-bg/60"
                : "border-primary/40 bg-primary-bg/30"
            }`}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-bg text-lg font-bold text-primary">
              ↑
            </span>
            <span className="text-[13px] font-bold text-text-dark">
              {pdfConverting
                ? "PDF 변환 중..."
                : file
                  ? `✓ ${file.name}`
                  : isDragging
                    ? "여기에 파일을 놓으세요"
                    : "계약서 파일을 끌어다 놓으세요"}
            </span>
            <input
              id="scan-upload"
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              onChange={handleFileChange}
            />
          </label>
          <p className="-mt-2 text-[11px] text-text-lightgray">
            <BrokenText
              text={
                'JPG · PNG · PDF · 최대 15MB · PDF는 업로드 시 자동으로 이미지로 변환돼요.'
              }
            />
          </p>
          {pdfPageWarning && (
            <p className="-mt-2 text-[11px] text-amber-600">
              <BrokenText text={`⚠ ${pdfPageWarning}`} />
            </p>
          )}

          <form onSubmit={handleAnalyze} className="flex flex-col gap-3">
            <Input
              id="address"
              label="매물 주소"
              placeholder="예: 서울 관악구 봉천동 1234-5"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
            />
            <div className="flex gap-2.5">
              <Input
                id="deposit"
                label="전세 보증금 (만원)"
                placeholder="25000"
                inputMode="numeric"
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
                required
              />
              <Input
                id="buildingType"
                label="건물 유형"
                placeholder="다세대주택"
                value={buildingType}
                onChange={(e) => setBuildingType(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-xs font-medium text-danger">{error}</p>
            )}

            <Button type="submit" className="mt-1" disabled={loading || pdfConverting}>
              {loading
                ? "AI가 분석하는 중..."
                : pdfConverting
                  ? "PDF 변환 중..."
                  : "위험도 분석 시작"}
            </Button>
          </form>
          <p className="flex w-full items-center justify-center gap-1 text-center text-[11px] text-text-lightgray">
            <img src="/icons/home/lock.svg" alt="" aria-hidden="true" className="shrink-0" />
            <span>업로드한 계약서는 분석 후 안전하게 삭제됩니다</span>
          </p>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <div
            key={feature.title}
            className="rounded-2xl border border-border bg-subtle p-6"
          >
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-white text-primary shadow-sm">
              <span className="flex h-[30px] w-[30px] items-center justify-center"><img src={`/icons/home/${feature.icon}.svg`} alt="" aria-hidden="true" className="max-w-none scale-125" /></span>
            </div>
            <div className="text-balance text-[17px] font-bold text-text-dark">
              {feature.title}
            </div>
            <p className="mt-1.5 text-pretty text-[13px] leading-relaxed text-text-gray">
              {feature.body}
            </p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="text-sm font-bold text-text-dark lg:text-base">
          뉴스 살펴보기
        </h2>
        <p className="mt-1 text-xs font-medium text-primary-dark lg:text-[13px]">
          최근 발생한 전세사기 관련 뉴스를 확인해 보세요
        </p>
        <Card className="mt-3 p-0">
          {newsLoading ? (
            <p className="p-4 text-xs text-text-gray">뉴스를 불러오는 중...</p>
          ) : newsError ? (
            <p className="p-4 text-xs text-danger">{newsError}</p>
          ) : newsItems.length === 0 ? (
            <p className="p-4 text-xs text-text-gray">
              아직 등록된 뉴스가 없어요.
            </p>
          ) : (
            <>
              <ul className="flex flex-col divide-y divide-border px-4">
                {(newsExpanded
                  ? newsItems
                  : newsItems.slice(0, NEWS_PAGE_SIZE)
                ).map((item) => (
                  <li key={item.id} className="py-3.5">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-[13px] font-medium leading-snug text-text-dark hover:text-primary"
                    >
                      {item.title}
                    </a>
                    <p className="mt-1 text-[11px] text-text-lightgray">
                      {item.media ? `${item.media} · ` : ""}
                      {formatNewsDate(item.published_at)}
                    </p>
                  </li>
                ))}
              </ul>
              {newsItems.length > NEWS_PAGE_SIZE && (
                <button
                  type="button"
                  onClick={() => setNewsExpanded((v) => !v)}
                  className="w-full border-t border-border py-3 text-center text-xs font-bold text-primary"
                >
                  {newsExpanded ? "접기" : "뉴스 더보기"}
                </button>
              )}
            </>
          )}
        </Card>
      </section>
    </div>
  );
}
