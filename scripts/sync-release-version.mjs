import { readFileSync, writeFileSync } from "node:fs";

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const cliPath = "cli/package.json";
const cliPackage = JSON.parse(readFileSync(cliPath, "utf8"));

cliPackage.version = rootPackage.version;
writeFileSync(cliPath, `${JSON.stringify(cliPackage, null, 2)}\n`);
