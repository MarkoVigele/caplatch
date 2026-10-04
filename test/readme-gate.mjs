import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const toml = readFileSync(join(root, "wrangler.toml"), "utf8");
const fixture = readFileSync(join(root, "test", "fixture.ts"), "utf8");

const DIFFERENCE =
  "Caplatch refuses before the call goes out, including when it cannot prove budget remains; AI Gateway can let a burst through.";

if (!readme.includes(DIFFERENCE)) {
  throw new Error("the difference sentence is missing");
}
if (!readme.includes("The cent amount is an estimate from the table, not the OpenRouter invoice.")) {
  throw new Error("the estimate sentence is missing");
}
if (!readme.includes("Using the OpenRouter key directly and bypassing the Worker is outside the latch.")) {
  throw new Error("the bypass sentence is missing");
}

const fixtureValues = [...fixture.matchAll(/export const \w+ = "([^"]+)";/g)].map((match) => match[1]);
if (fixtureValues.length < 2) {
  throw new Error("test fixture values were not found");
}

function filesUnder(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
    } else {
      found.push(path);
    }
  }
  return found;
}

const srcText = filesUnder(join(root, "src"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
for (const value of fixtureValues) {
  if (toml.includes(value)) {
    throw new Error("wrangler.toml contains a secret value");
  }
  if (srcText.includes(value)) {
    throw new Error("fixture token is outside tests");
  }
}

const code = toml
  .split("\n")
  .map((line) => {
    const hash = line.indexOf("#");
    return hash === -1 ? line : line.slice(0, hash);
  })
  .join("\n");

if (/\bOPENROUTER_API_KEY\b/.test(code) || /\bGATE_TOKEN\b/.test(code)) {
  throw new Error("wrangler.toml contains a secret value");
}
if (/sk-[A-Za-z0-9]/.test(toml) || /Bearer\s+\S+/.test(toml)) {
  throw new Error("wrangler.toml contains a secret value");
}
if (!/UPSTREAM_ENABLED\s*=\s*"false"/.test(code)) {
  throw new Error('wrangler.toml must keep UPSTREAM_ENABLED = "false"');
}
