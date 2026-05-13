# notion-update-form

거친 메모 한 줄도 OK인 가벼운 입력 폼. 임원이 노션 페이지 안에서 폼만 채우면 `전략과제 업데이트 이력` DB에 바로 기록됩니다.

## 구성

```
[임원 노션 페이지]
  └─ <embed: HTML 폼>   ← GitHub Pages 정적 호스팅
       ↓ "Notion에 저장" 클릭
  [Cloudflare Worker]   ← NOTION_TOKEN, CORS 처리
       ↓ Notion API
  [전략과제 업데이트 이력 DB]
```

## 폴더

- `public/index.html` — 폼 UI (GitHub Pages 배포)
- `worker/` — Cloudflare Worker (Notion 프록시)
- `.github/workflows/pages.yml` — GitHub Pages 자동 배포

## 1) GitHub Pages 배포

리포에 푸시되면 `pages.yml` 워크플로우가 자동으로 `public/` 폴더를 배포합니다. URL 예시:

```
https://dataagentkim-cpu.github.io/notion-update-form/
```

Settings → Pages → "Build and deployment" 를 `GitHub Actions` 로 설정 필요.

## 2) Cloudflare Worker 배포 (1회 설정)

```bash
# 0) 사전: 노드 18+ 설치 확인
node --version

# 1) Worker 폴더에서 의존성 설치
cd worker
npm install

# 2) Cloudflare 로그인 (브라우저 OAuth)
npx wrangler login

# 3) NOTION_TOKEN 시크릿 등록
npm run secret:notion
# 프롬프트에 ntn_... 토큰 붙여넣기

# 4) 배포
npm run deploy
# 결과 예시: https://notion-update-form.<your-subdomain>.workers.dev
```

배포 후 출력되는 URL을 복사해서 `public/index.html` 의 `WORKER_URL` 상수에 넣고 커밋:

```js
const WORKER_URL = 'https://notion-update-form.<your-subdomain>.workers.dev';
```

## 3) Notion 페이지에 임베드

각 임원 페이지 상단에:

1. `/embed` 입력 → GitHub Pages URL 붙여넣기 → "임베드 생성"
2. 높이 조절 (약 700px 권장)

## 노션 DB 스키마 가정

`전략과제 업데이트 이력` 데이터 소스 (`92ba1af2-5b00-4993-b43e-67fb2749dd4d`)에 다음 속성이 있어야 합니다:

| 속성명 | 타입 | 비고 |
|---|---|---|
| `전략과제명` | title | 자동으로 `전략과제 - 요약` 형식 생성 |
| `요약제목` | text | |
| `상세내용` | text | |
| `작성일자` | date | 기본값 = 오늘 |
| `작성자` | relation → 임원 리스트 | 이름으로 자동 매칭 |
| `전략과제 명 1` | relation → 전략과제 | 이름으로 자동 매칭 |

속성명이 다르면 `worker/src/worker.js` 상단 `SU_PROP_*` 상수를 수정하세요.

## 보안

- `NOTION_TOKEN` 은 Worker 시크릿(서버 측)에만 저장됩니다. 브라우저로 절대 노출되지 않습니다.
- `ALLOWED_ORIGIN` 을 본인의 GitHub Pages 도메인으로 제한하면 외부에서 Worker 호출 방지.
- 매칭 실패(존재하지 않는 임원/과제명) 시에도 row는 생성되며, `warnings`로 응답에 포함됩니다.

## 향후

- [ ] AI 다듬기 ("거친 메모 → 정돈된 문장") — Anthropic Claude 연동
- [ ] 작성자/전략과제 자동완성 (dropdown)
- [ ] 파일 첨부 지원
