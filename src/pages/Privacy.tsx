import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import BrokenText from '../components/ui/BrokenText'
import Card from '../components/ui/Card'
import TopNav from '../components/TopNav'

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="뒤로가기"
      className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-text-gray shadow-card"
    >
      ←
    </button>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-bold text-text-dark">{title}</h2>
      <div className="mt-1.5 text-xs leading-relaxed text-text-gray">{children}</div>
    </div>
  )
}

export default function Privacy() {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <TopNav variant="app" />
      <div className="mx-auto w-full max-w-app flex-1 px-5 py-6 lg:max-w-[720px] lg:px-6 lg:py-10">
        <div className="flex items-center gap-3">
          <BackButton onClick={() => navigate(-1)} />
          <h1 className="text-lg font-bold text-primary lg:text-2xl">개인정보 처리방침</h1>
        </div>

        <Card className="mt-4 border-warning/40 bg-warning-bg/40 lg:mt-6">
          <p className="text-xs font-bold text-text-dark">⚠️ 안내</p>
          <p className="mt-1 text-[11px] leading-relaxed text-text-gray">
            <BrokenText text="이 문서는 ONZIP 서비스 이해를 돕기 위한 참고용 템플릿이며, 변호사 등 전문가의 법률 자문을 대체하지 않습니다. 실제 서비스 운영 및 개인정보보호법 등 관계 법령 준수를 위해서는 반드시 법률 전문가의 검토를 받아 확정해주세요." />
          </p>
        </Card>

        <div className="mt-4 flex flex-col gap-5 lg:mt-6">
          <Section title="1. 수집하는 개인정보 항목">
            <ul className="flex flex-col gap-1">
              <li>· 이메일 주소 (회원가입 및 로그인, 본인 확인 목적)</li>
              <li>· 업로드한 계약서·등기부등본 등 문서 이미지/파일</li>
              <li><BrokenText text="· 마음 상담(가스라이팅 분석) 기능에 입력한 채팅·문자 내용 및 캡처 이미지" /></li>
              <li>· 서비스 이용 과정에서 자동 생성되는 분석 이력(위험도 점수, 분석 일시 등)</li>
            </ul>
          </Section>

          <Section title="2. 개인정보 수집 및 이용 목적">
            <p>
              <BrokenText text="수집한 정보는 전세사기 위험도 분석 및 심리 조작(가스라이팅) 패턴 분석 서비스를 제공하기 위한 목적으로만 사용됩니다. 구체적으로는 회원 식별 및 로그인 유지, AI 기반 위험도 분석 결과 생성, 분석 이력 조회 기능 제공, 서비스 품질 개선을 위한 통계 분석에 활용됩니다." />
            </p>
          </Section>

          <Section title="3. 개인정보의 제3자 제공">
            <p className="mb-1.5">
              <BrokenText text="회사는 원칙적으로 이용자의 개인정보를 외부에 제공하지 않으나, 아래의 경우 분석 서비스 제공을 위해 필요한 최소한의 정보를 제3자에게 전달합니다." />
            </p>
            <ul className="flex flex-col gap-1">
              <li>
                · <span className="font-medium text-text-dark">Google Gemini API (Google LLC)</span> — 업로드된
                계약서/등기부등본 및 마음 상담 채팅 내용을 AI 위험도 분석 목적으로 전달
              </li>
              <li>
                · <span className="font-medium text-text-dark">네이버(NAVER Corp.)</span> — 매물 주소 등 부동산
                시세·지역 정보 조회 목적으로 필요한 정보를 전달
              </li>
              <li>
                · <span className="font-medium text-text-dark">카카오(Kakao Corp.)</span> — 지도 표시 및 위치 기반
                안심 시그널 맵 기능 제공 목적으로 필요한 정보를 전달
              </li>
            </ul>
          </Section>

          <Section title="4. 개인정보의 보관 및 삭제">
            <p>
              <BrokenText text="이용자의 개인정보는 회원 탈퇴 시 지체 없이 파기됩니다. 계약서 스캔 및 마음 상담 분석 이력을 포함한 관련 데이터 역시 회원 탈퇴와 함께 삭제되며, 별도로 다운로드하거나 백업해두지 않은 데이터는 복구할 수 없습니다. 관계 법령에 따라 일정 기간 보관이 필요한 정보가 있는 경우 해당 법령에서 정한 기간 동안 별도 보관 후 파기합니다." />
            </p>
          </Section>

          <Section title="5. 이용자의 권리">
            <p>
              <BrokenText text="이용자는 언제든지 프로필 화면에서 본인의 분석 이력을 조회할 수 있으며, 회원탈퇴를 통해 본인의 개인정보 및 관련 데이터 삭제를 요청할 수 있습니다. 그 밖의 문의사항은 고객센터를 통해 접수해주세요." />
            </p>
          </Section>

          <Section title="6. 서비스 이용에 따른 법적 책임">
            <p>
              <BrokenText text="계약서 위험도 분석 및 마음 상담(가스라이팅 패턴 분석) 결과는 AI가 제공하는 참고 정보이며, 법률 자문이나 전문가의 진단을 대체하지 않습니다. AI 분석에는 오류나 누락이 있을 수 있으므로, 이용자는 계약 체결이나 실제 상황 판단 전 반드시 등기부등본 등 원본 서류를 직접 확인하고 필요시 공인중개사·변호사 등 전문가와 상담해야 합니다. 분석 결과를 참고해 이용자가 내린 계약·법적 판단 및 그로 인한 결과에 대한 책임은 이용자 본인에게 있으며, 회사는 AI 분석 결과의 정확성을 보증하지 않습니다." />
            </p>
          </Section>
        </div>
      </div>
    </div>
  )
}
