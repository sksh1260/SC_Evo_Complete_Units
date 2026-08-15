# SC: Evo 패치 관리자 설정

이 Worker는 GitHub Pages의 공개 읽기 화면과 분리되어 있습니다. GitHub 로그인 계정이
`ADMIN_GITHUB_LOGINS`에 있을 때만 `Patch.csv`를 읽거나 저장할 수 있습니다.

## 1. GitHub OAuth App 만들기

GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**에서 생성합니다.

- Homepage URL: GitHub Pages 사이트 주소
- Authorization callback URL: `https://<worker-name>.<account>.workers.dev/auth/callback`
- Client ID와 Client secret을 보관합니다.

## 2. GitHub 저장 토큰 만들기

Fine-grained personal access token을 만들고 이 저장소만 선택합니다.

- Repository permissions → **Contents: Read and write**

토큰은 브라우저나 `app.js`에 넣지 않습니다. Worker secret으로만 저장합니다.

## 3. wrangler.toml 수정

다음 값을 실제 값으로 바꿉니다.

- `FRONTEND_ORIGIN`: 예 `https://my-id.github.io` (도메인만)
- `FRONTEND_URL`: 예 `https://my-id.github.io/repository-name/` (GitHub Pages 실제 사이트 주소)
- `GITHUB_REPO`: 예 `my-id/SC-Evo-sheet`
- `ADMIN_GITHUB_LOGINS`: 관리자 GitHub 로그인명. 여러 명이면 쉼표로 구분합니다.

## 4. Worker 배포

Cloudflare에 로그인한 터미널에서 실행합니다.

```bash
cd worker
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_REPO_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

`SESSION_SECRET`에는 길고 임의적인 문자열을 넣습니다. 배포가 끝나면 Worker 주소가 표시됩니다.

## 5. 사이트 연결

`app.js`의 `PATCH_ADMIN_API_URL`에 배포된 Worker 주소를 입력합니다.

```js
var PATCH_ADMIN_API_URL = "https://sc-evo-patch-admin.<account>.workers.dev";
```

그 뒤 GitHub Pages에 `app.js`, `index.html`, `style.css`와 `worker` 폴더를 올립니다.

## 동작 방식

1. 관리자가 사이트에서 **관리자 로그인**을 누릅니다.
2. Worker가 GitHub 로그인 계정을 확인합니다.
3. 허용된 관리자만 **패치 관리** 화면을 열 수 있습니다.
4. 저장 시 Worker가 `Patch.csv`를 저장소에 커밋합니다.
5. GitHub Pages 배포 후 모든 방문자가 갱신된 패치 내역을 봅니다.
