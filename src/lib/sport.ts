// 종목마다 다른 "핵심 순간"을 고르는 기준. 화면 분석으로 잴 수 있는 신호로 나눕니다.
// - 격투기: 공격이 들어가는 짧고 강한 순간, 연타(콤보) — 실제 동작이 확 튀는 순간이 한 구간에 여러 번
// - 구기(축구·농구·야구 등): 드리블·돌파(계속 빠른 실제 동작) + 슛·덩크(튀는 순간) 뒤에 커지는 함성
// - 레이싱: 속도감 — 카메라가 빠르게 따라가는 구간을 살림(다른 종목에서는 카메라 이동을 빼고 봄)

export type SportKind = "combat" | "ball" | "racing" | "general";

export interface SportProfile {
  /** 이 정도 이상 튀어야 "임팩트"(공격·슛)로 봄 */
  impactMin: number;
  /** 한 구간 안 임팩트가 하나 더 있을 때마다 더할 점수(연타) — 최대 3개분 */
  comboBonus: number;
  /** 구간 뒤쪽으로 갈수록 소리가 커지면(슛 뒤 함성) 더할 점수 */
  climaxBonus: number;
  /** 빠른 동작이 계속되는 비율(드리블·질주)에 곱해 더할 점수 */
  driveBonus: number;
  /** 임팩트가 있는 영상에서, 임팩트가 없는 구간(걷기·견제·세리머니)에 곱하는 값 */
  noImpactFactor: number;
  /** 카메라 이동까지 움직임으로 칠지 (레이싱은 속도감이 핵심) */
  useCameraMotion: boolean;
  /** 임팩트가 구간 앞에서부터 이 비율쯤 오게 (슛은 조금 앞에 두어 뒤의 반응까지) */
  peakPosition: number;
  /** 편집에서 임팩트 순간에 살짝 줌·번쩍 강조를 넣을지 */
  accent: boolean;
  /**
   * 구간 점수에서 임팩트(결정적 순간)가 차지하는 비중 0~1. 격투기는 화려하게 움직이는 입장·관중 장면보다
   * 공격이 들어가는 순간이 핵심이라 크게 둡니다.
   */
  impactWeight: number;
  /**
   * 사람이 작게 보이는 넓은 장면(경기장 전경)을 우선할지. 격투기는 피부가 화면을 채우는 장면이 대개
   * 경기 전 얼굴 클로즈업·입장·소개 장면이라, 사람이 크게 보이는 순간을 높게 치면 경기가 빠집니다.
   */
  wideShots: boolean;
}

export const SPORT_PROFILES: Record<SportKind, SportProfile> = {
  combat: { impactMin: 0.25, comboBonus: 0.08, climaxBonus: 0.05, driveBonus: 0, noImpactFactor: 0.25, useCameraMotion: false, peakPosition: 0.4, accent: true, impactWeight: 0.6, wideShots: true },
  ball: { impactMin: 0.35, comboBonus: 0, climaxBonus: 0.2, driveBonus: 0.15, noImpactFactor: 0.6, useCameraMotion: false, peakPosition: 0.45, accent: true, impactWeight: 0.3, wideShots: false },
  racing: { impactMin: 0.35, comboBonus: 0, climaxBonus: 0.1, driveBonus: 0.2, noImpactFactor: 0.8, useCameraMotion: true, peakPosition: 0.55, accent: false, impactWeight: 0, wideShots: false },
  general: { impactMin: 0.35, comboBonus: 0, climaxBonus: 0, driveBonus: 0, noImpactFactor: 0.5, useCameraMotion: false, peakPosition: 0.55, accent: true, impactWeight: 0, wideShots: false },
};

const KIND_WORDS: [SportKind, RegExp][] = [
  ["combat", /\bufc\b|\bmma\b|격투|종합격투|복싱|복서|boxing|boxer|kick ?box|킥복싱|무에타이|muay ?thai|레슬링|wrestl|주짓수|jiu ?jitsu|유도|\bjudo\b|태권도|taekwondo|karate|가라테|파이터|fighter|knock ?out|녹아웃|\bko\b|펀치|punch|씨름|bellator|one championship/i],
  ["racing", /\bf1\b|formula ?(?:1|one)|포뮬러|레이싱|racing|moto ?gp|드리프트|drift|nascar|랠리|\brally\b|카트|karting|자동차 ?경주/i],
  ["ball", /축구|football|soccer|footballer|풋살|futsal|프리미어 ?리그|premier league|champions league|챔피언스 ?리그|라리가|la liga|분데스|bundesliga|serie a|k ?리그|\bfifa\b|월드컵|world cup|농구|basketball|\bnba\b|\bkbl\b|덩크|dunk|야구|baseball|\bmlb\b|\bkbo\b|홈런|home ?run|배구|volleyball|핸드볼|handball|하키|hockey|럭비|rugby|미식축구|\bnfl\b|테니스|tennis|드리블|dribbl|슛|shoot|골키퍼|goalkeeper|striker|공격수|미드필더/i],
];

/** 주제 설명·이름·관련 주제·특징 문장·영상 제목에서 종목을 알아봅니다. 모르면 null */
export function detectSport(...texts: (string | null | undefined)[]): SportKind | null {
  const text = texts.filter(Boolean).join(" ");
  if (!text.trim()) return null;
  for (const [kind, re] of KIND_WORDS) if (re.test(text)) return kind;
  return null;
}
