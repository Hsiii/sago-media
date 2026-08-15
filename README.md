# Sago Media

The product behind `media.hsichen.dev`: authenticated uploads, GitHub-backed
device approval, media processing and retention, and the `sago-media` CLI.

## Clients

```bash
npx sago-media@0.1.0 auth login
npx sago-media@0.1.0 upload screenshot.png
npx sago-media@0.1.0 upload screenshot.png --repo Hsiii/example --pr 42 --output markdown
```

Friends receive `upload:pr` access after owner approval. The owner's GitHub
identity receives `upload:any`. Credentials are delivered once and stored only
as hashes by the service.

## Configuration

- `PR_MEDIA_BASE_URL` and `MEDIA_PUBLIC_URL`
- `MEDIA_GITHUB_CLIENT_ID` and `MEDIA_GITHUB_CLIENT_SECRET`
- `MEDIA_OWNER_GITHUB_ID`, using GitHub's immutable numeric user ID
- upload limits from the existing `PR_MEDIA_*` variables, including the
  processing timeout in `PR_MEDIA_UPLOAD_TIMEOUT_MS`

The GitHub OAuth callback is `$MEDIA_PUBLIC_URL/auth/github/callback`.

## Workspace

- `server/` contains the Bun API, authentication, database, and dashboard API.
- `web/` contains the Vite and React admin dashboard.
- `cli/` contains the published `sago-media` command.
- `scripts/` contains the media processing pipeline.

Run both development servers together:

```bash
bun run dev
```

The dashboard is available from Vite at `http://localhost:5173/admin/`; API
requests are proxied to the Bun service on port 3000.

## Build and test

```bash
bun run test
bun run build
docker build -t sago-media .
```

## Release

Sign in to npm locally, then release from a clean `main`:

```bash
npm login
GITHUB_TOKEN="$(gh auth token)" bun run release
```

Release-it prompts for the version bump, updates both package versions, runs
the checks, creates the release commit and tag, publishes the CLI, and creates
the GitHub release. npm stays attached to the terminal so browser-based
authentication and two-factor challenges can complete. The repository ruleset
allows only the repository owner to bypass the pull-request requirement for
this release push. Tagged releases also publish the multi-architecture
container image.

Infrastructure repositories should deploy the published container image and
provide storage, routing, secrets, health checks, and schedules. They should
not contain this repository's application or client source.
