// Loads variables from the repository .env (when present); real environment variables win.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadEnv() {
  const file = fileURLToPath(new URL("../../../.env", import.meta.url));
  const fromFile = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && !line.trimStart().startsWith("#")) fromFile[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return { ...fromFile, ...process.env };
}
