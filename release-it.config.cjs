module.exports = {
  git: {
    commitMessage: "chore: release sago-media v${version}",
    requireBranch: "main",
    tagName: "v${version}",
  },
  github: {
    autoGenerate: true,
    release: true,
  },
  hooks: {
    "before:bump": "bun --cwd .. run check",
    "after:bump": "node ../scripts/sync-release-version.mjs",
    "before:git:release": "git add ../package.json package.json",
    "after:git:release":
      "npm publish . --registry=https://registry.npmjs.org </dev/tty >/dev/tty",
  },
  npm: {
    publish: false,
  },
};
