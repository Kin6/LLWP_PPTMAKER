import { spawnSync } from "node:child_process";

const commands = [
  ["npx", ["vitest", "run", "tests/unit/deck-agent", "tests/integration/deck-agent"]],
  ["npx", [
    "playwright",
    "test",
    "tests/e2e/deck-agent-ui.spec.ts",
    "tests/e2e/sandbox-security.spec.ts",
    "tests/e2e/offline-export.spec.ts",
    "tests/e2e/visual-qa.spec.ts",
  ]],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
