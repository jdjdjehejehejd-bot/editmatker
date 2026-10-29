# editmatker — AI Edit Studio

**[앱 실행하기 (Manus Preview)](https://8328-ixzuggzo9wj9jiinpx2qm-f144e382.sg2.manus.computer)**

인물과 분위기를 입력하면 공개 라이선스가 표시된 영상을 자동으로 가져와 AI 편집 타임라인과 세로형 MP4 초안을 만드는 한국어 편집 작업대입니다. 직접 영상 파일을 준비하지 않아도 시작할 수 있습니다.

## 시작하기

```bash
pnpm install
pnpm dev
```

Node.js 22+, pnpm 10.18+, `ffmpeg`, `ffprobe`, 그리고 한글 자막용 Noto CJK 글꼴이 필요합니다. 컨테이너 배포는 Dockerfile에서 FFmpeg와 글꼴을 설치합니다. `pnpm check`, `pnpm test`, `pnpm build`로 타입·테스트·프로덕션 빌드를 실행합니다.

AI 초안과 최신 YouTube 참고 검색에는 실행 플랫폼의 `MANUS_API_URL`과 `MANUS_API_KEY` 서버 환경변수가 필요합니다. Wikimedia Commons 공개 파일 검색은 API 키 없이 동작합니다. 로컬에서는 키를 비밀 저장소나 로컬 환경에 두고 `.env`를 Git에 커밋하지 마세요. 비밀 키는 브라우저로 전송되지 않습니다.

## 편집 흐름

1. 인물과 분위기를 입력합니다. `최신 자료 찾기`는 YouTube의 최신 공개 영상을 참고 링크로 보여줍니다. YouTube 결과는 자동 다운로드하거나 편집 소스로 사용하지 않습니다.
2. `영상 파일 없이 공개 클립 자동 가져오기`를 누르면 Wikimedia Commons에서 해당 인물 관련 영상 중 라이선스가 표시된 자료를 검색하고, 검색 후보 가운데 Commons 등록일이 최근인 순으로 적격 소스를 최대 3개까지 자동으로 가져옵니다. 등록일은 Commons 업로드 시점이며 촬영일과 같다는 보장은 없습니다. 파일당 최대 50MB이며 편집 소스는 최대 6개입니다. 적격 공개 소스가 부족하면 직접 제작했거나 재사용 허가를 받은 파일을 선택적으로 업로드할 수 있습니다.
3. 각 자동 소스의 작성자·라이선스·Commons 출처 링크를 확인하고 사용 조건에 동의한 뒤, 인물과 분위기 프롬프트로 AI 타임라인을 만듭니다.
4. FFmpeg가 9:16, 540×960 MP4를 렌더링합니다. Commons 자료가 들어가면 영상 끝에 5초 크레딧 카드를 넣고 전체 영상은 60초 이내로 제한합니다. 타임라인 JSON 내보내기에는 전체 파일 출처와 라이선스 링크가 포함됩니다. 선택적 배경음악과 한국어 캡션을 지원합니다. 자동 게시 기능은 없습니다.

## 데이터와 권리

- 자동 가져오기는 명시된 `Public domain`, `CC0`, `CC BY`, `CC BY-SA` 라이선스만 허용하며, 라이선스를 확인할 수 없거나 목록 밖인 파일은 건너뜁니다. `CC BY-SA` 자료를 사용한 편집물을 배포할 때는 해당 라이선스의 동일조건변경허락 의무를 검토해야 합니다.
- Commons 파일의 라이선스·작성자 정보는 외부 메타데이터이며 앱이 저작권 소유권, 정보의 법적 정확성, 인물의 초상권·퍼블리시티권·개인정보 등을 검증하지 않습니다. 사용자는 개별 자료의 원본 페이지와 이용 조건을 확인해야 합니다.
- YouTube는 참고 검색만 지원하고 영상 파일을 가져오지 않습니다. 현재 Commons 외의 일반 웹 기사나 다른 플랫폼 자동 수집은 지원하지 않습니다.
- 사용자 업로드는 직접 제작했거나 편집·재사용 허가를 받은 파일만 이용해야 합니다. 업로드 전 권리 확인란은 이용자의 자기확인이며 법적 허가를 검증하지 않습니다.
- Commons 자동 수집과 업로드 미디어는 서버 임시 작업 디렉터리에 최대 2시간 보관되며, 서버 재시작·컨테이너 교체 때 더 일찍 사라질 수 있습니다. 파일 콘텐츠는 Git이나 영구 저장소에 넣지 않습니다. 각 미디어 작업은 서버 발급 무작위 세션 토큰으로 격리됩니다.
- 최근 프로젝트·타임라인·출처 메타데이터는 브라우저 `localStorage`에 보존하지만 원본 파일과 MP4 렌더 결과는 보관하지 않습니다. 만료된 소스는 자동으로 다시 가져오거나 렌더할 수 없으며, 사용자는 파일을 다시 가져와야 합니다.
- 공개 API는 서버 프로세스의 IP별 고정 창 요청 제한(검색/AI tRPC 30회/분, 자동 공개 소스 3회/10분, 업로드 12회/10분, 렌더 8회/10분)을 사용합니다. 이는 단일 프로세스 수준의 기본 완화책이지 분산 환경의 완전한 남용 방지 보장은 아닙니다.

## 구현 구성

- `client/src/pages/Home.tsx`, `client/src/index.css`: 편집 워크스페이스, 자동 소스 불러오기, 라이선스 출처 표시 및 브라우저 프로젝트 목록.
- `server/editmaker.ts`: YouTube 참고 검색, Wikimedia Commons 라이선스 필터와 미디어 수집, LLM 타임라인 생성, 임시 파일 관리 및 FFmpeg 렌더·크레딧 카드.
- `server/routers.ts`: 입력 검증된 검색·자동 소스·AI tRPC 절차.
- `server/_core/index.ts`: 미디어 HTTP 엔드포인트 등록.
- `client/public/manus-routes.json`: 단일 공개 페이지 경로 선언.

앱은 React, Express, tRPC, TypeScript 및 Drizzle 스타터를 기반으로 하며 DB는 현재 사용하지 않습니다. 외부 계약 참고: [Wikimedia Commons 재사용 안내](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia), [MediaWiki 이미지 정보 API](https://www.mediawiki.org/wiki/API:Imageinfo), [YouTube Search API](https://developers.google.com/youtube/v3/docs/search/list).
