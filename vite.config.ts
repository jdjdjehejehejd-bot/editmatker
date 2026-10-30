/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 상대 경로 base로 빌드해 GitHub Pages(/editmatker/)와 로컬 미리보기 모두에서 동작합니다.
export default defineConfig({
  base: "./",
  plugins: [react()],
  // 장면 검열 모델(tfjs·NSFW.js)은 필요할 때만 따로 받는 큰 파일이라 크기 경고를 넓힙니다.
  build: { chunkSizeWarningLimit: 4000 },
  test: { environment: "node" },
});
