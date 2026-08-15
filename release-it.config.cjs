module.exports = {
  git: {
    commitMessage: "chore: release sago-media v${version}",
    tagName: "v${version}",
  },
  github: {
    autoGenerate: true,
    release: true,
  },
  hooks: {
    "before:bump": "bun run check",
    "after:bump": "node scripts/sync-release-version.mjs",
    "before:git:release": "git add cli/package.json",
    "after:git:release": "npm publish ./cli --registry=https://registry.npmjs.org",
  },
  npm: {
    publish: false,
  },
};
