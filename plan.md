# editmatker 구현 계획

## 목표와 범위

사용자가 인물과 분위기를 입력하면 최신 공개 영상 후보를 출처·게시일과 함께 보고, 영상 파일을 직접 올리지 않아도 공개 라이선스가 표시된 관련 영상을 자동으로 임시 소스로 가져와 AI 편집 초안과 세로형 MP4를 만들 수 있는 한국어 웹앱을 구현한다. 자동 소스는 Wikimedia Commons의 파일 API를 사용하며, YouTube 결과는 계속 참고 링크로만 제공한다. 개별 파일의 라이선스 메타데이터는 업로더가 제출한 정보이므로 법적 권리나 인물 초상권·개인정보를 검증한다고 표시하지 않는다. 안전한 라이선스 허용목록에 있는 영상만 가져오며 작가·라이선스·원본 링크를 화면, MP4의 크레딧 카드, 내보내는 타임라인 JSON에 표시한다. 직접 업로드도 선택지로 유지한다. 데이터베이스는 비활성 상태이므로 최근 프로젝트 메타데이터는 브라우저 저장소, 원본 미디어는 임시 작업 저장소를 사용한다.

## 구현 접근

- 기존 WebDev React / TypeScript / Tailwind / Express / tRPC 스타터를 재사용한다. 연결을 확인한 Manus API 허브의 `Youtube/search`로 게시 시점순 최신 참고 후보를 가져온다. 별도 Commons 검색·가져오기 경로는 Wikimedia Commons MediaWiki API를 서버에서 호출한다. 자동 가져오기는 HTTPS `upload.wikimedia.org` 미디어에 한정하며 `Public domain`, `CC0`, `CC BY`와 `CC BY-SA`의 명시적 허용 버전만 받는다. 검색 후보는 최대 30개에서 적격성 필터 후 Commons 등록일 내림차순으로 선택하며 촬영일과 구별한다. 최대 3개, 파일당 50MB 이하로 제한한다. YouTube 영상은 참고 링크로만 남기고 자동 다운로드하지 않는다.
- Commons 후보마다 파일 제목, 작성자, 라이선스, 원본 설명 페이지 및 라이선스 URL을 정규화해 저장한다. 라이선스가 비어 있거나 허용목록 밖이면 다운로드하지 않는다. 공개 메타데이터의 정확성을 보장하지 않고 UI에서 인물 초상권 등 별도 권리 검토를 안내한다.
- 인물·분위기 프롬프트와 자동으로 가져온 미디어 또는 권리 확인된 사용자 업로드를 기반으로 LLM이 장면 순서, 컷 길이, 전환, 짧은 한국어 캡션을 포함한 타임라인 JSON을 만든다. FFmpeg로 9:16, 540×960 H.264 MP4를 렌더하고 Commons 소스가 사용되면 영상 끝에 작성자·파일·라이선스 크레딧 카드를 붙인다. 타임라인 JSON에는 전체 출처 링크와 라이선스 정보를 담는다.
- 서버는 업로드 MIME·확장자·80MB 요청 한도·미디어 길이를 검사한다. 자동 수집 요청은 상위 파일 크기와 개수 제한, 고정된 Wikimedia 호스트 allowlist, 검색 20초·파일 다운로드 35초 제한시간과 IP별 자동 수집 10분당 3회 요청 제한을 적용한다. 외부 검색 URL을 그대로 가져오지 않는다. 모든 원본은 임시 폴더에 두고 최대 2시간 후 삭제하며 계정 간 자산 접근은 서버 발급 임의 토큰으로 격리한다.
- 최근 프로젝트/타임라인 메타데이터는 `localStorage`에 두고, 원본 미디어는 서버 재시작·세션 만료 시 사라질 수 있음을 알린다. 비밀키는 브라우저에 포함하지 않는다.

## 시스템 구조

- `client/src/pages/Home.tsx`: 인물/분위기 입력, YouTube 참고 검색, Commons 자동 소스 가져오기, 라이선스/출처 표시, 업로드, 타임라인 검토 및 미리보기 UI.
- `client/src/index.css`, `client/src/App.tsx`: 디자인 토큰, 반응형 레이아웃 및 재사용 인터랙션.
- `server/routers.ts`: zod 검증된 검색·자동 소스·AI 편집 절차.
- `server/editmaker.ts`: YouTube 참고 검색 정규화, Wikimedia Commons 라이선스 허용목록·미디어 수집, AI 타임라인 생성, 임시 파일 관리 및 FFmpeg 렌더/크레딧 카드.
- `client/public/manus-routes.json`: 사용자 노출 경로 선언.
- `plan.md`, `TODO.md`: 승인된 설계 및 기능 상태.

## 디자인

후보 스타일: **인디 시네마 편집 콘솔** (확률 0.08), **바우하우스 방송 제어판** (확률 0.06), **저채도 아카이브 리서치룸** (확률 0.04). 선택: 인디 시네마 편집 콘솔.

- **Design Movement**: 현대 독립영화 편집실의 타임라인·큐시트 미학.
- **Core Principles**: 콘텐츠 중심, 권리 상태의 명료성, 편집 결과의 검토 가능성, 복잡함을 줄인 단계형 작업.
- **Color Philosophy**: 따뜻한 종이색 바탕과 잉크색 텍스트로 작업실 감도를 주고, 고유한 산호빛 오렌지를 재생·생성 상태에만 제한적으로 사용한다. 권리 미확인은 중립 회색, 확인 완료는 청록으로 구분한다.
- **Layout Paradigm**: 좌측 세로 탐색 레일, 넓은 중앙 편집 캔버스, 오른쪽 컨텍스트 패널로 구성된 비대칭 3영역 편집기. 모바일에서는 단계형 단일 열로 전환.
- **Signature Elements**: 영상 프레임 모서리의 타임코드 인덱스, 얇은 필름 프레임 경계, 오렌지색 재생 위치선.
- **Interaction Philosophy**: 출처와 라이선스를 편집 전에 볼 수 있게 하고, 참고 링크와 실제 다운로드된 편집 소스를 분리한다.
- **Animation**: 패널·탭 전환 160–220ms, 재생 헤드는 선형으로 이동, 결과 로딩은 점멸 대신 차분한 스켈레톤; 모션 감소 설정 준수.
- **Typography System**: UI는 Pretendard 또는 시스템 sans-serif, 숫자/타임코드는 ui-monospace; 제목은 28–36px, 섹션 14–18px, 폼 라벨 12–13px.
- **Brand Essence**: “공개 자료 탐색에서 허용 라이선스 영상 편집까지 이어주는 팬 편집 작업대”; 성격은 신중함·창의적·실용적.
- **Brand Voice**: 간결하고 창작자를 존중한다. 예: “먼저 장면을 모으고, 이야기를 엮어요.” / “출처와 라이선스 조건을 확인하고 편집에 넣어요.”
- **Wordmark & Logo**: 세 개의 타임라인 컷과 오렌지 재생 헤드를 결합한 단순한 필름 편집 아이콘과 소문자 워드마크.
- **Signature Brand Color**: 코랄 오렌지 `#F26A4B`.

## 프로젝트와 저장소

WebDev 관리 프로젝트는 `/home/ubuntu/editmaker`에 있으며 GitHub 사용자가 지정한 비공개 저장소는 별도 경로 `/home/ubuntu/editmatker`다. 변경은 두 저장소에 보존한다. 기존 사용자 파일이나 원격 커밋을 덮어쓰지 않는다.

## 외부 소스 계약 참고

- [YouTube Data API Search: list](https://developers.google.com/youtube/v3/docs/search/list) — 검색 API는 후보를 제공하며 이 앱에서는 YouTube 파일 다운로드를 구현하지 않는다.
- [YouTube 서비스 약관](https://www.youtube.com/t/terms) — 영상 취득·사용은 제공된 API/서비스의 조건을 따라야 하므로 결과를 참고 링크로만 제공한다.
- [MediaWiki API: Search](https://www.mediawiki.org/wiki/API:Search), [MediaWiki API: Imageinfo](https://www.mediawiki.org/wiki/API:Imageinfo) — Commons 파일 검색과 라이선스/미디어 URL 메타데이터를 받는 경로.
- [Wikimedia Commons 재사용 안내](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia), [Creative Commons 라이선스 목록](https://creativecommons.org/licenses/) — 개별 파일 조건 확인, 저작자 표시, ShareAlike 의무 및 앱이 법적 권리를 검증하지 않는다는 고지의 기준.
