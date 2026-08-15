FROM oven/bun:1.3.9-debian AS web-build

WORKDIR /app

COPY package.json bun.lock bunfig.toml /app/
COPY cli/package.json /app/cli/package.json
COPY web/package.json /app/web/package.json
RUN bun install --frozen-lockfile

COPY web /app/web
RUN bun run build:web

FROM oven/bun:1.3.9-debian

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg file gh jpegoptim libimage-exiftool-perl optipng util-linux webp \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 sago-media \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sago-media

WORKDIR /app

COPY --chmod=755 scripts/pr-media-optimize /usr/local/bin/pr-media-optimize
COPY --chmod=755 scripts/pr-media-pin /usr/local/bin/pr-media-pin
COPY --chmod=755 scripts/pr-media-prune /usr/local/bin/pr-media-prune
COPY --chmod=755 scripts/pr-media-upload /usr/local/bin/pr-media-upload
COPY --chmod=755 scripts/pr-media-verify /usr/local/bin/pr-media-verify
COPY server /app/server
COPY --from=web-build /app/web/dist /app/web/dist

ENV PR_MEDIA_ROOT=/srv/pr-media
ENV PR_MEDIA_MAX_VIDEO_BYTES=95000000

EXPOSE 3000
USER 10001:10001
CMD ["bun", "/app/server/index.ts"]
