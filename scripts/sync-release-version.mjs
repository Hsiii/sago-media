import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rootPackagePath = join(root, "package.json");
const cliPackagePath = join(root, "cli/package.json");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8"));

rootPackage.version = cliPackage.version;
writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
