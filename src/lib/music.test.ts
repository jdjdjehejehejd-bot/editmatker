import { describe, expect, it } from "vitest";
import { analyzeTempo } from "./music";

function clickTrack(bpm: number, seconds: number, sampleRate: number, offset: number, loudFrom: number) {
  const samples = new Float32Array(seconds * sampleRate);
  const beat = 60 / bpm;
  for (let t = offset; t < seconds; t += beat) {
    const start = Math.floor(t * sampleRate);
    const amp = t >= loudFrom ? 1 : 0.2;
    for (let i = 0; i < 800 && start + i < samples.length; i++) samples[start + i] = amp * Math.exp(-i / 150) * Math.sin(i * 0.3);
  }
  return samples;
}

describe("analyzeTempo", () => {
  it("클릭 트랙의 BPM과 드롭 지점을 찾는다", () => {
    const sampleRate = 22050;
    const info = analyzeTempo(clickTrack(120, 30, sampleRate, 0.25, 12), sampleRate);
    expect(Math.abs(info.bpm - 120)).toBeLessThan(3);
    const beat = 0.5;
    const phaseError = Math.abs(((info.firstBeat - 0.25 + beat / 2) % beat) - beat / 2);
    expect(phaseError).toBeLessThan(0.05);
    expect(Math.abs(info.dropTime - 12)).toBeLessThanOrEqual(2);
  });
});

describe("자동 작곡이 매번 다르게", () => {
  it("씨앗이 다르면 조·화음 순서·드럼·멜로디가 달라지고, 같으면 같음", async () => {
    const { pickVariation, variedProgression } = await import("./music");
    const a = pickVariation("hype", 0.11);
    expect(pickVariation("hype", 0.11)).toEqual(a);
    const seeds = Array.from({ length: 12 }, (_, i) => (i + 1) / 13);
    const shapes = new Set(seeds.map(seed => JSON.stringify([pickVariation("hype", seed), variedProgression("hype", pickVariation("hype", seed))])));
    expect(shapes.size).toBeGreaterThan(8);
  });

  it("씨앗이 없으면 예전 곡 그대로", async () => {
    const { pickVariation, variedProgression } = await import("./music");
    const plain = pickVariation("cinematic");
    expect(plain).toMatchObject({ transpose: 0, rotate: 0, swap: false, motif: [] });
    expect(variedProgression("cinematic", plain)[0]).toEqual({ bass: 33, chord: [57, 60, 64] });
    // 하이햇이 없는 분위기는 씨앗이 있어도 없음
    expect(pickVariation("cinematic", 0.5).hats).toEqual([]);
  });
});
