import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
const named = [
  ...new Set(
    [...readme.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1])
      .filter((token) => /^[a-z0-9-]+\/[a-z0-9.-]+$/.test(token)),
  ),
];
const expected = ["openai/gpt-4o-mini", "openai/gpt-4o"];
if (named.length !== expected.length || expected.some((id) => !named.includes(id))) {
  throw new Error(
    `README must name exactly openai/gpt-4o-mini and openai/gpt-4o, found: ${named.join(", ") || "(none)"}`,
  );
}
