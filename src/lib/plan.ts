// 하이라이트를 음악 박자에 맞춰 타임라인으로 엮습니다. 순수 함수입니다.

import type { Highlight } from "./highlights";
import type { EditStyle } from "./style";

export type Section = "intro" | "drop" | "outro";

export interface Segment {
  sourceId: string;
  srcStart: number;
  /** 타임라인 시작(초) */
  start: number;
  /** 타임라인 길이(초) */
  duration: number;
  /** 재생 속도 (1 미만이면 슬로모션) */
  rate: number;
  section: Section;
  zoom: "in" | "out" | "none";
  flash: boolean;
  glitch: boolean;
  shake: boolean;
  /** 앞 컷에서 넘어오는 방식: 바로 컷 · 크로스페이드 · 휩(빠른 가로 흔들림) · 줌 펀치 */
  transition: "cut" | "fade" | "whip" | "punch";
  /** 벨로시티: 컷 안에서 빨라졌다 느려졌다 하는 속도 램프 */
  velocity: boolean;
  /** 컷 안에서 결정적 순간(공격·슛)이 오는 때(컷 시작부터 초) — 그 순간에 살짝 줌·번쩍 강조 */
  hitAt?: number;
}

export interface EditPlan {
  bpm: number;
  beatOffset: number;
  dropAt: number;
  duration: number;
  segments: Segment[];
}

export interface PlanInput {
  highlights: Highlight[];
  style: EditStyle;
  totalSeconds: number;
  bpm?: number;
  beatOffset?: number;
  /** 음악의 드롭 시점(초). 없으면 전체의 25% 지점의 마디로 잡습니다. */
  dropAt?: number;
  /**
   * 컷 하나의 최소 박자 수. 격투기는 한 박자(0.4초 남짓) 컷이면 펀치가 들어가기 전에 끊기므로 2박 이상으로.
   */
  minCutBeats?: number;
  /** 번쩍임을 컷마다 넣지 않고 구간이 바뀔 때만 (결정적 순간 강조가 따로 있는 격투기 — 컷마다 번쩍이면 의미 없는 전환처럼 보임) */
  quietCuts?: boolean;
}

export const SLOWMO_RATE = 0.65;

export function beatsToSeconds(beats: number, bpm: number) {
  return (beats * 60) / bpm;
}

/** 하이라이트 구간을 뽑을 때 필요한 원본 길이(초) */
export function requiredHighlightLength(style: EditStyle, bpm = style.bpm) {
  const longest = Math.max(...style.cutBeats.intro, ...style.cutBeats.drop, ...style.cutBeats.outro);
  const rate = style.effects.has("slowmo") ? SLOWMO_RATE : 1;
  return Math.min(6, Math.max(1, beatsToSeconds(longest, bpm) * rate));
}

/**
 * 출처별로 번갈아 가며 점수 순으로 섞어 같은 영상이 연달아 나오지 않게 합니다.
 * 영상마다 비중(weight)이 다르면 그 비율대로 자주 나오게 합니다(부드러운 가중 라운드 로빈).
 */
export function interleaveBySource(highlights: Highlight[], length = highlights.length): Highlight[] {
  const groups = new Map<string, Highlight[]>();
  for (const h of [...highlights].sort((a, b) => b.score - a.score)) {
    if (!groups.has(h.sourceId)) groups.set(h.sourceId, []);
    groups.get(h.sourceId)!.push(h);
  }
  const lanes = [...groups.values()].map(list => ({ list, next: 0, weight: Math.max(0.01, list[0].weight ?? 1), current: 0 }));
  const result: Highlight[] = [];
  // 장면보다 컷이 많으면(length > 장면 수) 영상마다 자기 장면을 처음부터 다시 쓰며 비중을 지킵니다.
  // 예전에는 다 쓴 영상이 빠져서, 짧은 영상에 큰 비중을 줘도 남은 컷이 다른 영상으로 채워졌습니다.
  const wrap = length > highlights.length;
  let round = 0;
  while (result.length < length && highlights.length) {
    if (wrap) {
      for (const lane of lanes) {
        if (lane.next < lane.list.length) continue;
        // 다시 쓸 때 같은 순서로 돌면 같은 장면 묶음이 통째로 반복돼 보이므로, 바퀴마다 순서를 바꿉니다
        // (방금 쓴 장면이 바로 또 나오지 않게).
        const last = lane.list[lane.list.length - 1];
        round++;
        lane.list = reorder(lane.list, round);
        if (lane.list.length > 1 && lane.list[0] === last) lane.list.push(lane.list.shift()!);
        lane.next = 0;
      }
    }
    const open = lanes.filter(lane => lane.next < lane.list.length);
    const total = open.reduce((sum, lane) => sum + lane.weight, 0);
    for (const lane of open) lane.current += lane.weight;
    // 동점이면 다음 장면 점수가 높은 쪽을 먼저 씁니다.
    const pick = open.reduce((best, lane) =>
      lane.current > best.current + 1e-9 || (Math.abs(lane.current - best.current) <= 1e-9 && lane.list[lane.next].score > best.list[best.next].score) ? lane : best
    );
    pick.current -= total;
    result.push(pick.list[pick.next++]);
  }
  return result;
}

/** 장면 목록을 바퀴마다 다른 순서로: 짝수 바퀴는 거꾸로, 그리고 바퀴 수만큼 돌림 */
function reorder<T>(list: T[], round: number): T[] {
  const base = round % 2 ? [...list].reverse() : [...list];
  const shift = Math.floor((round * list.length) / 3) % Math.max(1, list.length);
  return [...base.slice(shift), ...base.slice(0, shift)];
}

function fillSection(pattern: number[], totalBeats: number): number[] {
  const cuts: number[] = [];
  let used = 0;
  for (let i = 0; used < totalBeats; i++) {
    const beats = Math.min(pattern[i % pattern.length], totalBeats - used);
    cuts.push(beats);
    used += beats;
  }
  return cuts;
}

/**
 * 팬 에딧에서 흔히 쓰는 전환을 무드에 맞게 고릅니다.
 * - 하이프: 드롭 컷마다 줌 펀치, 네 번째마다 휩
 * - 감성: 전부 크로스페이드
 * - 시네마틱: 인트로·아웃트로는 크로스페이드, 드롭은 세 번째마다 휩
 * - 레트로: 드롭 세 번째마다 휩
 */
export function pickTransition(style: EditStyle, section: Section, dropIndex: number): Segment["transition"] {
  // 전환을 직접 골랐으면 모든 컷에 그 전환을 씁니다.
  if (style.transition) return style.transition;
  if (style.mood === "emotional") return "fade";
  if (style.mood === "cinematic") return section === "drop" ? (dropIndex % 3 === 2 ? "whip" : "cut") : "fade";
  if (section !== "drop") return "cut";
  if (style.mood === "hype") return dropIndex % 4 === 3 ? "whip" : "punch";
  return dropIndex % 3 === 2 ? "whip" : "cut";
}

/** 결정적 순간이 이 컷 안에서 언제 오는지 (강조할 순간이 없거나 컷 밖이면 없음) */
function hitTime(h: Highlight, srcStart: number, rate: number, duration: number, velocity = false): number | undefined {
  if (!h.accent || h.peak === undefined) return undefined;
  let at = (h.peak - srcStart) / rate;
  if (velocity) {
    // 벨로시티: 원본 위치 → 컷 안의 시각 (velocitySource를 거꾸로 풂)
    const target = at / duration;
    if (target >= velocitySource(1)) return undefined;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (velocitySource(mid) < target) lo = mid;
      else hi = mid;
    }
    at = lo * duration;
  }
  return at > 0.05 && at < duration - 0.05 ? at : undefined;
}

/** 맞은 뒤 반응까지 보이게 컷 안에 남길 시간(원본 초) */
export const AFTER_HIT = 0.5;

/**
 * 벨로시티 컷에서 진행률 p(0~1)까지 보여 준 원본 길이(컷 길이 대비). 재생 속도가 1.55 − 1.1·sin(πp)로 바뀌므로
 * (render.ts와 같은 식) 그 적분입니다. p=1이면 약 0.85.
 */
export function velocitySource(p: number): number {
  return 1.55 * p - (1.1 / Math.PI) * (1 - Math.cos(Math.PI * p));
}

export function buildPlan(input: PlanInput): EditPlan {
  const { style } = input;
  const bpm = input.bpm ?? style.bpm;
  const beat = 60 / bpm;
  const beatOffset = input.beatOffset ?? 0;
  const totalBeats = Math.max(8, Math.round((input.totalSeconds - beatOffset) / beat / 4) * 4);
  const dropBeat =
    input.dropAt !== undefined
      ? Math.max(4, Math.min(totalBeats - 8, Math.round((input.dropAt - beatOffset) / beat / 4) * 4))
      : // 특징 문장의 흐름("점점 고조" → 드롭을 늦게, "처음부터 터지게" → 일찍)을 따릅니다. 기본은 1/4 지점.
        Math.max(4, Math.min(totalBeats - 8, Math.round((totalBeats * (style.structure?.dropRatio ?? 0.25)) / 4) * 4));
  // "여운 있게"면 아웃트로를 길게(자리가 있을 때만).
  const wantedOutro = style.structure?.outroBeats ?? 4;
  const outroBeats = totalBeats - dropBeat >= 12 + wantedOutro ? wantedOutro : totalBeats - dropBeat >= 16 ? 4 : 0;

  const atLeast = (pattern: number[]) => (input.minCutBeats ? pattern.map(beats => Math.max(input.minCutBeats!, beats)) : pattern);
  const cutBeats = { intro: atLeast(style.cutBeats.intro), drop: atLeast(style.cutBeats.drop), outro: atLeast(style.cutBeats.outro) };
  const sections: { section: Section; beats: number }[] = [
    ...fillSection(cutBeats.intro, dropBeat).map(beats => ({ section: "intro" as const, beats })),
    ...fillSection(cutBeats.drop, totalBeats - dropBeat - outroBeats).map(beats => ({ section: "drop" as const, beats })),
    ...(outroBeats ? fillSection(cutBeats.outro, outroBeats) : []).map(beats => ({ section: "outro" as const, beats })),
  ];

  const pool = interleaveBySource(input.highlights, Math.max(input.highlights.length, sections.length));
  if (!pool.length) return { bpm, beatOffset, dropAt: beatOffset + dropBeat * beat, duration: 0, segments: [] };

  // 가장 좋은 장면은 드롭에, 그다음은 아웃트로, 나머지는 인트로에 배치합니다.
  // 장면이 부족하면 드롭부터 새 장면을 받고, 나머지 구간은 이미 쓴 장면을 다시 씁니다.
  const assigned = new Map<number, { h: Highlight; reuse: number }>();
  const usage = new Map<Highlight, number>();
  let next = 0;
  for (const section of ["drop", "outro", "intro"] as const) {
    sections.forEach((s, i) => {
      if (s.section !== section) return;
      const h = next < pool.length ? pool[next] : pool[pool.length - 1 - (next % pool.length)];
      next++;
      const reuse = usage.get(h) ?? 0;
      usage.set(h, reuse + 1);
      assigned.set(i, { h, reuse });
    });
  }

  const segments: Segment[] = [];
  let cursor = 0;
  let dropIndex = 0;
  sections.forEach(({ section, beats }, i) => {
    let duration = beatsToSeconds(beats, bpm);
    if (i === 0) duration += beatOffset;
    const { h, reuse } = assigned.get(i)!;
    // 긴 컷은 슬로모션으로 여운을 줍니다. 감성 무드는 인트로에도 적용합니다.
    const slowAllowed = section !== "intro" || style.mood === "emotional";
    const rate = style.effects.has("slowmo") && beats >= 4 && slowAllowed ? SLOWMO_RATE : 1;
    const srcLength = duration * rate;
    const shift = Math.max(0, h.length - srcLength);
    const inDrop = section === "drop";
    const velocity = style.effects.has("velocity") && inDrop && beats >= 2 && rate === 1;
    // 벨로시티는 원본을 고르게 재생하지 않아(빠르게 → 느리게 → 빠르게) 컷 하나가 원본의 85%쯤만 보여 줍니다.
    const srcSpan = velocity ? srcLength * velocitySource(1) : srcLength;
    let srcStart: number;
    if (h.peak !== undefined) {
      // 결정적 순간(임팩트)이 있으면 컷 안의 박자 위치에 오게 시작점을 잡습니다 — 2박 이상이면 가운데 박자, 1박이면 컷 40% 지점.
      // 맞는 순간 직후에 컷이 넘어가지 않게, 맞은 뒤 반응(AFTER_HIT초, 짧은 컷은 절반 이상)이 꼭 남게 합니다.
      // 같은 장면을 다시 쓸 때도 임팩트는 컷 안에 두고, 위치만 조금 앞당겨 반복감을 줄입니다.
      const after = Math.min(AFTER_HIT, srcSpan * 0.55);
      const wanted = beats >= 2 ? (Math.floor(beats / 2) / beats) * srcSpan : srcSpan * 0.4;
      const at = Math.max(Math.min(0.1, srcSpan * 0.2), Math.min(wanted, srcSpan - after) * (reuse ? 1 - 0.3 * ((reuse * 0.37) % 1) : 1));
      // 임팩트가 장면 끝에 가까우면 장면 뒤(원본에서 바로 이어지는 부분)로 조금 넘어가서라도 맞은 뒤를 보여 줍니다.
      const overrun = Math.max(0, after - (h.start + h.length - h.peak));
      srcStart = Math.min(h.start + shift + overrun, Math.max(h.start, h.peak - at));
    } else {
      // 같은 장면을 다시 쓸 때는 시작점을 조금씩 밀어 반복감을 줄입니다.
      srcStart = h.start + (reuse ? ((reuse * 0.37) % 1) * shift : 0);
    }
    segments.push({
      sourceId: h.sourceId,
      srcStart,
      start: cursor,
      duration,
      rate,
      section,
      zoom: style.effects.has("zoom") ? (i % 2 === 0 ? "in" : "out") : "none",
      flash: style.effects.has("flash") && ((!input.quietCuts && (inDrop || section === "outro")) || (i > 0 && sections[i - 1].section !== section)),
      glitch: style.effects.has("glitch") && inDrop && dropIndex % 4 === 3,
      shake: style.effects.has("shake") && inDrop,
      transition: i === 0 ? "cut" : pickTransition(style, section, inDrop ? dropIndex : -1),
      velocity,
      hitAt: hitTime(h, srcStart, rate, duration, velocity),
    });
    if (inDrop) dropIndex++;
    cursor += duration;
  });

  return { bpm, beatOffset, dropAt: beatOffset + dropBeat * beat, duration: cursor, segments };
}
