# media

The product behind `media.hsichen.dev`: authenticated uploads, GitHub-backed
device approval, media processing and retention, and the `@hsiii/media` CLI.

## Clients

```bash
npx @hsiii/media@0.1.0 auth login
npx @hsiii/media@0.1.0 upload screenshot.png
npx @hsiii/media@0.1.0 upload screenshot.png --repo Hsiii/example --pr 42 --output markdown
```

Friends receive `upload:pr` access after owner approval. The owner's GitHub
identity receives `upload:any`. Credentials are delivered once and stored only
as hashes by the service.

## Configuration

- `PR_MEDIA_BASE_URL` and `MEDIA_PUBLIC_URL`
- `MEDIA_GITHUB_CLIENT_ID` and `MEDIA_GITHUB_CLIENT_SECRET`
- `MEDIA_OWNER_GITHUB_ID`, using GitHub's immutable numeric user ID
- upload limits from the existing `PR_MEDIA_*` variables

The GitHub OAuth callback is `$MEDIA_PUBLIC_URL/auth/github/callback`.

## Build and test

```bash
bun run test
bun run build
docker build -t hsiii-media .
```

Infrastructure repositories should deploy the published container image and
provide storage, routing, secrets, health checks, and schedules. They should
not contain this repository's application or client source.
