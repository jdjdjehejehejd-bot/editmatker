/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 상대 경로 base로 빌드해 GitHub Pages(/editmatker/)와 로컬 미리보기 모두에서 동작합니다.
export default defineConfig({
  base: "./",
  plugins: [react()],
  test: { environment: "node" },
});
