// 저작권 걱정 없는 배경음악을 Web Audio로 직접 합성하고,
// 사용자가 고른 음악의 BPM·박자 위치·드롭 지점을 추정합니다.

import type { Mood } from "./style";

const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

// 마디마다 하나의 화음 (A 단조 계열)
const PROGRESSIONS: Record<Mood, { bass: number; chord: number[] }[]> = {
  hype: [
    { bass: 33, chord: [57, 60, 64] },
    { bass: 33, chord: [57, 60, 64] },
    { bass: 29, chord: [53, 57, 60] },
    { bass: 28, chord: [52, 56, 59] },
  ],
  cinematic: [
    { bass: 33, chord: [57, 60, 64] },
    { bass: 29, chord: [53, 57, 60] },
    { bass: 36, chord: [55, 60, 64] },
    { bass: 31, chord: [55, 59, 62] },
  ],
  emotional: [
    { bass: 41, chord: [57, 60, 65] },
    { bass: 36, chord: [55, 60, 64] },
    { bass: 43, chord: [55, 59, 62] },
    { bass: 45, chord: [57, 60, 64] },
  ],
  retro: [
    { bass: 33, chord: [57, 60, 64] },
    { bass: 31, chord: [55, 59, 62] },
    { bass: 29, chord: [53, 57, 60] },
    { bass: 31, chord: [55, 59, 62] },
  ],
};

interface Pattern {
  kick: number[];
  snare: number[];
  hats: number[];
  /** 베이스: 16분음표 위치 */
  bass: number[];
  /** 아르페지오 위치 */
  arp: number[];
}

const PATTERNS: Record<Mood, Pattern> = {
  hype: { kick: [0, 7, 10], snare: [8], hats: [0, 2, 4, 6, 8, 10, 12, 14], bass: [0, 7, 10], arp: [] },
  cinematic: { kick: [0, 8], snare: [8], hats: [], bass: [0], arp: [0, 2, 4, 6, 8, 10, 12, 14] },
  emotional: { kick: [0, 10], snare: [8], hats: [2, 6, 10, 14], bass: [0, 8], arp: [0, 2, 4, 6, 8, 10, 12, 14] },
  retro: { kick: [0, 4, 8, 12], snare: [4, 12], hats: [2, 6, 10, 14], bass: [0, 2, 4, 6, 8, 10, 12, 14], arp: [0, 3, 6, 8, 11, 14] },
};

export interface MusicOptions {
  mood: Mood;
  bpm: number;
  /** 음악 전체 길이(초) — 크레딧 포함 */
  duration: number;
  /** 드롭 시작(초) */
  dropAt: number;
  /** 아웃트로 시작(초) */
  outroAt: number;
  sampleRate?: number;
}

export async function synthesizeMusic(options: MusicOptions): Promise<AudioBuffer> {
  const sampleRate = options.sampleRate ?? 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(options.duration * sampleRate), sampleRate);
  const { mood, bpm } = options;
  const step = 60 / bpm / 4;
  const barLength = step * 16;

  const master = ctx.createGain();
  master.gain.value = 0.8;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.ratio.value = 4;
  master.connect(compressor).connect(ctx.destination);
  // 끝부분 페이드아웃
  master.gain.setValueAtTime(0.8, Math.max(0, options.duration - 2.5));
  master.gain.linearRampToValueAtTime(0, options.duration);

  const noise = ctx.createBuffer(1, sampleRate, sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const env = (node: AudioParam, t: number, peak: number, attack: number, decay: number) => {
    node.setValueAtTime(0.0001, t);
    node.exponentialRampToValueAtTime(peak, t + attack);
    node.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };

  const noiseHit = (t: number, gain: number, decay: number, type: BiquadFilterType, freq: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = ctx.createGain();
    env(g.gain, t, gain, 0.002, decay);
    src.connect(filter).connect(g).connect(master);
    src.start(t, Math.random() * 0.5, decay + 0.05);
  };

  const kick = (t: number, gain = 1) => {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(mood === "cinematic" ? 110 : 150, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    const g = ctx.createGain();
    env(g.gain, t, gain, 0.003, mood === "cinematic" ? 0.7 : 0.38);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.8);
  };

  const snare = (t: number, gain = 0.5) => {
    noiseHit(t, gain, mood === "emotional" ? 0.08 : 0.18, "highpass", 1400);
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const g = ctx.createGain();
    env(g.gain, t, gain * 0.6, 0.002, 0.1);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.2);
  };

  const tone = (t: number, freq: number, length: number, gain: number, type: OscillatorType, cutoff: number, detune = 0) => {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, length / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + length);
    filter.connect(g).connect(master);
    for (const d of detune ? [-detune, detune] : [0]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = d;
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + length + 0.05);
    }
  };

  const pad = (t: number, notes: number[], length: number, gain: number) => {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = mood === "retro" ? 2200 : 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.4, length / 3));
    g.gain.setValueAtTime(gain, t + length - 0.15);
    g.gain.linearRampToValueAtTime(0.0001, t + length);
    filter.connect(g).connect(master);
    for (const note of notes) {
      for (const d of [-9, 9]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = midiToHz(note);
        osc.detune.value = d;
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + length + 0.05);
      }
    }
  };

  const riser = (start: number, end: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(300, start);
    filter.frequency.exponentialRampToValueAtTime(7000, end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.35, end - 0.02);
    g.gain.linearRampToValueAtTime(0, end);
    src.connect(filter).connect(g).connect(master);
    src.start(start);
    src.stop(end);
  };

  const pattern = PATTERNS[mood];
  const progression = PROGRESSIONS[mood];
  const musicEnd = options.duration - 0.5;
  const bars = Math.ceil(musicEnd / barLength);

  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * barLength;
    if (barStart >= musicEnd) break;
    const chord = progression[bar % progression.length];
    const section = barStart < options.dropAt - 1e-3 ? "intro" : barStart < options.outroAt - 1e-3 ? "drop" : "outro";
    const length = Math.min(barLength, musicEnd - barStart);
    pad(barStart, section === "drop" ? chord.chord : chord.chord.map(n => n - 12), length, section === "drop" ? 0.05 : 0.07);

    for (let s = 0; s < 16; s++) {
      const t = barStart + s * step;
      if (t >= musicEnd) break;
      const lastIntroBar = section === "intro" && barStart + barLength >= options.dropAt - 1e-3;
      if (section === "drop") {
        if (pattern.kick.includes(s)) kick(t);
        if (pattern.snare.includes(s)) snare(t);
        if (pattern.hats.includes(s)) noiseHit(t, s % 4 === 2 ? 0.16 : 0.1, 0.04, "highpass", 8000);
        // 하이프: 네 마디마다 하이햇 롤
        if (mood === "hype" && bar % 4 === 3 && s >= 12) noiseHit(t + step / 2, 0.1, 0.03, "highpass", 8000);
        if (pattern.bass.includes(s)) {
          const octave = mood === "retro" && s % 4 === 2 ? 12 : 0;
          const bassLength = mood === "hype" ? step * 3 : mood === "retro" ? step * 0.9 : step * 7;
          tone(t, midiToHz(chord.bass + 12 + octave), bassLength, mood === "hype" ? 0.5 : 0.28, mood === "hype" ? "sine" : "sawtooth", mood === "hype" ? 900 : 500);
        }
        if (pattern.arp.includes(s)) {
          const note = chord.chord[(s / 2) % chord.chord.length | 0] + (mood === "emotional" ? 12 : 0);
          tone(t, midiToHz(note), step * 1.8, mood === "emotional" ? 0.09 : 0.06, mood === "emotional" ? "triangle" : "square", 3000, 6);
        }
        if (mood === "cinematic" && [3, 6, 11, 14].includes(s)) kick(t, 0.35);
      } else if (section === "intro") {
        // 인트로: 화음과 가벼운 리듬만
        if (mood === "emotional" && pattern.arp.includes(s)) tone(t, midiToHz(chord.chord[(s / 2) % 3 | 0] + 12), step * 2, 0.07, "triangle", 2500);
        if (mood !== "emotional" && s % 4 === 0 && bar > 0) noiseHit(t, 0.05, 0.03, "highpass", 9000);
        if (lastIntroBar && mood !== "emotional" && s >= 8) snare(t, 0.12 + (s - 8) * 0.04);
      } else if (s === 0) {
        tone(t, midiToHz(chord.bass + 12), barLength, 0.25, "sine", 400);
      }
    }
  }

  // 드롭 직전 라이저와 드롭 순간의 임팩트
  if (options.dropAt > barLength / 2) riser(Math.max(0, options.dropAt - barLength), options.dropAt);
  kick(options.dropAt, 1.2);
  noiseHit(options.dropAt, 0.4, 1.4, "highpass", 3000);
  if (options.outroAt < musicEnd) {
    kick(options.outroAt, 1);
    noiseHit(options.outroAt, 0.3, 2, "highpass", 4000);
  }

  return ctx.startRendering();
}

// ---------------------------------------------------------------------------
// 사용자 음악 분석

export interface TempoInfo {
  bpm: number;
  firstBeat: number;
  dropTime: number;
}

/** 모노 신호에서 BPM, 첫 박 위치, 가장 크게 터지는 지점(드롭)을 추정합니다. */
export function analyzeTempo(samples: Float32Array, sampleRate: number): TempoInfo {
  const hop = 512;
  const frames = Math.floor(samples.length / hop);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += samples[i] * samples[i];
    energy[f] = Math.log(1e-6 + sum / hop);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);

  const frameRate = sampleRate / hop;
  const minLag = Math.floor((frameRate * 60) / 180);
  const maxLag = Math.ceil((frameRate * 60) / 70);
  let bestLag = Math.round((frameRate * 60) / 120);
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let f = lag; f < frames; f++) sum += onset[f] * onset[f - lag];
    const bpm = (frameRate * 60) / lag;
    // 사람이 느끼는 템포(100~130)를 약간 선호합니다.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.6) ** 2);
    const score = (sum / (frames - lag)) * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // 정수 지연 주변에서 주기와 위상을 함께 세밀하게 맞춥니다 (빗살 필터).
  const peakAt = (f: number) => {
    const i = Math.round(f);
    return Math.max(onset[i - 1] ?? 0, onset[i] ?? 0, onset[i + 1] ?? 0);
  };
  let period = bestLag;
  let bestPhase = 0;
  let combScore = -Infinity;
  for (let p = bestLag - 1; p <= bestLag + 1; p += 0.02) {
    for (let phase = 0; phase < p; phase++) {
      let sum = 0;
      for (let f = phase; f < frames; f += p) sum += peakAt(f);
      if (sum > combScore) {
        combScore = sum;
        period = p;
        bestPhase = phase;
      }
    }
  }
  const bpm = Math.round(((frameRate * 60) / period) * 10) / 10;
  const firstBeat = bestPhase / frameRate;

  // 2초 단위 RMS가 가장 크게 뛰어오르는 지점을 드롭으로 봅니다.
  const windowFrames = Math.max(1, Math.round(frameRate * 2));
  const rms: number[] = [];
  for (let f = 0; f + windowFrames <= frames; f += windowFrames) {
    let sum = 0;
    for (let i = f; i < f + windowFrames; i++) sum += Math.exp(energy[i]);
    rms.push(Math.sqrt(sum / windowFrames));
  }
  let dropIndex = 0;
  let jump = -Infinity;
  for (let i = Math.max(1, Math.floor(rms.length * 0.1)); i < rms.length; i++) {
    const delta = rms[i] - rms[i - 1];
    if (delta > jump) {
      jump = delta;
      dropIndex = i;
    }
  }
  return { bpm, firstBeat, dropTime: dropIndex * 2 };
}

/** 사용자 음악 파일을 디코딩하고, 드롭이 편집의 앞쪽 1/4쯤 오도록 잘라냅니다. */
export async function prepareUserMusic(file: File, totalSeconds: number) {
  const ctx = new OfflineAudioContext(2, 44100, 44100);
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  const mono = new Float32Array(decoded.length);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const channel = decoded.getChannelData(ch);
    for (let i = 0; i < channel.length; i++) mono[i] += channel[i] / decoded.numberOfChannels;
  }
  const tempo = analyzeTempo(mono, decoded.sampleRate);
  const beat = 60 / tempo.bpm;
  let start = Math.max(0, tempo.dropTime - totalSeconds * 0.25);
  // 시작점을 박자 격자에 맞춥니다.
  start = tempo.firstBeat + Math.max(0, Math.round((start - tempo.firstBeat) / beat)) * beat;
  if (start + totalSeconds > decoded.duration) start = Math.max(0, decoded.duration - totalSeconds);
  const beatOffset = (((tempo.firstBeat - start) % beat) + beat) % beat;
  return {
    buffer: decoded,
    offset: start,
    bpm: tempo.bpm,
    beatOffset,
    dropAt: Math.max(0, tempo.dropTime - start),
  };
}
