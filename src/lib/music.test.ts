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
