module.exports = {
  git: {
    commit: false,
    push: false,
    requireBranch: "main",
    tagName: "v${version}",
  },
  github: {
    autoGenerate: true,
    release: true,
  },
  hooks: {
    "before:init": "bun run check",
    "before:git:release":
      "npm publish ./cli --registry=https://registry.npmjs.org",
    "before:github:release": "git push origin v${version}",
  },
  npm: false,
};
