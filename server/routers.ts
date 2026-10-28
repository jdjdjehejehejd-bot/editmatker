import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { createEditDraft, editmakerSchemas, searchPublicVideos } from "./editmaker";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  editmaker: router({
    search: publicProcedure.input(editmakerSchemas.search).mutation(async ({ input }) => {
      try {
        const videos = await searchPublicVideos(input);
        return { videos, source: "YouTube", rightsNotice: "검색 결과는 참고 링크입니다. 사용 권한이 확인된 파일만 편집에 추가할 수 있어요." };
      } catch (error) {
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: error instanceof Error ? error.message : "자료 검색에 실패했어요." });
      }
    }),
    draft: publicProcedure.input(editmakerSchemas.draft).mutation(async ({ input }) => {
      try {
        return await createEditDraft(input);
      } catch (error) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "편집 초안을 만들지 못했어요." });
      }
    }),
  }),
});

export type AppRouter = typeof appRouter;
