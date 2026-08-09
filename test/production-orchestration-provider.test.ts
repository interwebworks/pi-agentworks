import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installSelectedProviderAuthentication } from "../src/infrastructure/controller/production-orchestration-provider.ts";

test("private child configuration receives only the selected provider credential", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-provider-auth-"));
  const config = join(root, "config");
  const source = join(root, "auth.json");
  try {
    mkdirSync(config, { mode: 0o700 });
    writeFileSync(
      source,
      JSON.stringify({
        "openai-codex": { type: "oauth", access: "selected-secret" },
        anthropic: { type: "oauth", access: "excluded-secret" },
      }),
      { mode: 0o600 },
    );
    chmodSync(source, 0o600);

    installSelectedProviderAuthentication(config, "openai-codex", source);

    assert.deepEqual(
      JSON.parse(readFileSync(join(config, "auth.json"), "utf8")),
      {
        "openai-codex": { type: "oauth", access: "selected-secret" },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoration reuses the private selected credential without reading a caller credential source", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-provider-reuse-"));
  const config = join(root, "config");
  try {
    mkdirSync(config, { mode: 0o700 });
    writeFileSync(
      join(config, "auth.json"),
      JSON.stringify({
        "openai-codex": { type: "oauth", access: "private-selected-secret" },
      }),
      { mode: 0o600 },
    );
    installSelectedProviderAuthentication(
      config,
      "openai-codex",
      join(root, "missing-caller-auth.json"),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(config, "auth.json"), "utf8")),
      {
        "openai-codex": {
          type: "oauth",
          access: "private-selected-secret",
        },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
