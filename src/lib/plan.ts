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
export function interleaveBySource(highlights: Highlight[]): Highlight[] {
  const groups = new Map<string, Highlight[]>();
  for (const h of [...highlights].sort((a, b) => b.score - a.score)) {
    if (!groups.has(h.sourceId)) groups.set(h.sourceId, []);
    groups.get(h.sourceId)!.push(h);
  }
  const lanes = [...groups.values()].map(list => ({ list, next: 0, weight: Math.max(0.01, list[0].weight ?? 1), current: 0 }));
  const result: Highlight[] = [];
  while (result.length < highlights.length) {
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

export function buildPlan(input: PlanInput): EditPlan {
  const { style } = input;
  const bpm = input.bpm ?? style.bpm;
  const beat = 60 / bpm;
  const beatOffset = input.beatOffset ?? 0;
  const totalBeats = Math.max(8, Math.round((input.totalSeconds - beatOffset) / beat / 4) * 4);
  const dropBeat =
    input.dropAt !== undefined
      ? Math.max(4, Math.min(totalBeats - 8, Math.round((input.dropAt - beatOffset) / beat / 4) * 4))
      : Math.max(4, Math.round((totalBeats * 0.25) / 4) * 4);
  const outroBeats = totalBeats - dropBeat >= 16 ? 4 : 0;

  const sections: { section: Section; beats: number }[] = [
    ...fillSection(style.cutBeats.intro, dropBeat).map(beats => ({ section: "intro" as const, beats })),
    ...fillSection(style.cutBeats.drop, totalBeats - dropBeat - outroBeats).map(beats => ({ section: "drop" as const, beats })),
    ...(outroBeats ? fillSection(style.cutBeats.outro, outroBeats) : []).map(beats => ({ section: "outro" as const, beats })),
  ];

  const pool = interleaveBySource(input.highlights);
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
    // 결정적 순간(임팩트)이 있으면 컷 안의 박자 위치에 오게 시작점을 잡습니다 — 주먹을 내지르기 직전에 컷이 넘어가지 않고,
    // 맞는 순간이 비트에 떨어지게. 2박 이상이면 가운데 박자, 1박이면 컷 가운데쯤.
    const impactAt = beats >= 2 ? (Math.floor(beats / 2) / beats) * srcLength : srcLength * 0.5;
    const srcStart =
      h.peak !== undefined && shift > 0 && !reuse
        ? Math.min(h.start + shift, Math.max(h.start, h.peak - impactAt))
        : // 같은 장면을 다시 쓸 때는 시작점을 조금씩 밀어 반복감을 줄입니다.
          h.start + (reuse ? ((reuse * 0.37) % 1) * shift : 0);
    const inDrop = section === "drop";
    segments.push({
      sourceId: h.sourceId,
      srcStart,
      start: cursor,
      duration,
      rate,
      section,
      zoom: style.effects.has("zoom") ? (i % 2 === 0 ? "in" : "out") : "none",
      flash: style.effects.has("flash") && (inDrop || section === "outro" || (i > 0 && sections[i - 1].section !== section)),
      glitch: style.effects.has("glitch") && inDrop && dropIndex % 4 === 3,
      shake: style.effects.has("shake") && inDrop,
      transition: i === 0 ? "cut" : pickTransition(style, section, inDrop ? dropIndex : -1),
      velocity: style.effects.has("velocity") && inDrop && beats >= 2 && rate === 1,
    });
    if (inDrop) dropIndex++;
    cursor += duration;
  });

  return { bpm, beatOffset, dropAt: beatOffset + dropBeat * beat, duration: cursor, segments };
}
