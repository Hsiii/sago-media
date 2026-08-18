# Sago Media

Self-hosted media upload and processing backend for [Sago Drop](https://github.com/sago-cream/sago-drop). It provides device authorization, bounded uploads, media optimization, public share links, and an administration dashboard.

The former npm CLI and pull-request upload API were removed in v1.0.0. Use [`gh-image`](https://github.com/drogers0/gh-image) or GitHub's editor for pull-request attachments.

## Configuration

- `PR_MEDIA_BASE_URL` and `MEDIA_PUBLIC_URL`
- `MEDIA_GITHUB_CLIENT_ID` and `MEDIA_GITHUB_CLIENT_SECRET`
- `MEDIA_OWNER_GITHUB_ID`, using GitHub's immutable numeric user ID
- upload limits from the existing `PR_MEDIA_*` variables, including `PR_MEDIA_UPLOAD_TIMEOUT_MS`

The GitHub OAuth callback is `$MEDIA_PUBLIC_URL/auth/github/callback`.

## Workspace

- `server/` contains the Bun API, authentication, database, and dashboard API.
- `web/` contains the Vite and React admin dashboard.
- `scripts/` contains the media processing pipeline.

Run the development servers together:

```bash
bun run dev
```

The dashboard is available from Vite at `http://localhost:5173/admin/`; API requests are proxied to the Bun service on port 3000.

## Build and test

```bash
bun run check
docker build -t sago-media .
```

## Release

After merging a release commit that updates `package.json`, create and push the matching tag. Tagged releases publish the multi-architecture container image.

```bash
git tag v1.0.0
git push origin v1.0.0
```
