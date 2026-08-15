# Sago Media

Upload screenshots, recordings, and other media for pull requests without
committing binaries to the repository. Sago Media provides reusable share
links, approval-based access, media processing, and an `npx` CLI for agents and
contributors.

## Quick start

```bash
npx sago-media auth login
npx sago-media upload recording.mov \
  --repo Hsiii/example \
  --pr 42 \
  --output markdown
```

Login opens `media.hsichen.dev` in the browser. New devices enter an approval
queue; after the owner approves one, the CLI stores its credential locally.
Friends receive access to PR uploads, while the owner's GitHub identity can
also make general-purpose uploads. The service stores credential hashes, not
the credentials themselves.

## Other clients

- The [Sago Media Mac app](https://github.com/Hsiii/sago-media-macos)
  provides quick personal uploads for links that can be pasted into Discord or
  elsewhere.
- `npx sago-media upload <path>` creates a general-purpose share link when the
  authenticated identity has permission.
- The admin dashboard handles access requests and upload activity.

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

This repository owns the application, clients, and media processing behavior.
Deployment repositories only provide the published container with storage,
routing, secrets, health checks, and schedules.

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
