// Clawdock Helpers tests cover clawdock helpers script behavior.
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shellCases = [
  { available: true, shell: "bash" },
  {
    available: spawnSync("zsh", ["--version"], { stdio: "ignore" }).status === 0,
    shell: "zsh",
  },
];

async function writeExecutable(file: string, content: string) {
  await writeFile(file, content, { mode: 0o755 });
}

async function createComposeSandbox(prefix = "openclaw-clawdock-") {
  const tempDir = await mkdtemp(path.join(tmpdir(), prefix));
  const projectDir = path.join(tempDir, "project");
  const binDir = path.join(tempDir, "bin");
  await mkdir(projectDir);
  await mkdir(binDir);
  await writeFile(path.join(projectDir, "docker-compose.yml"), "services: {}\n");
  return { tempDir, projectDir, binDir };
}

function helperEnv(params: {
  projectDir: string;
  binDir: string;
  homeDir: string;
  extra?: Record<string, string>;
}) {
  return {
    ...process.env,
    CLAWDOCK_DIR: params.projectDir,
    HOME: params.homeDir,
    PATH: `${params.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...params.extra,
  };
}

describe("scripts/clawdock/clawdock-helpers.sh", () => {
  for (const { available, shell } of shellCases) {
    it.runIf(available)(
      `preserves caller state while auto-detecting the checkout in ${shell}`,
      async () => {
        const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-clawdock-"));
        try {
          const homeDir = path.join(tempDir, "home");
          const projectDir = path.join(homeDir, "openclaw");
          const confirmFile = path.join(tempDir, "confirm.txt");
          await mkdir(projectDir, { recursive: true });
          await writeFile(path.join(projectDir, "docker-compose.yml"), "services: {}\n");
          await writeFile(confirmFile, "\n");

          await execFileAsync(
            shell,
            [
              "-c",
              [
                'path_before="$PATH"',
                'candidate="caller-value"',
                'response="caller-response"',
                "source scripts/clawdock/clawdock-helpers.sh || exit 1",
                '_clawdock_ensure_dir < "$CLAWDOCK_CONFIRM_FILE" || exit 1',
                '[[ "$PATH" == "$path_before" ]] || exit 1',
                '[[ "$candidate" == "caller-value" ]] || exit 1',
                '[[ "$response" == "caller-response" ]] || exit 1',
                '[[ "$CLAWDOCK_DIR" == "$HOME/openclaw" ]] || exit 1',
              ].join("\n"),
            ],
            {
              cwd: repoRoot,
              env: {
                ...process.env,
                CLAWDOCK_CONFIRM_FILE: confirmFile,
                CLAWDOCK_DIR: "",
                HOME: homeDir,
              },
            },
          );

          await expect(readFile(path.join(homeDir, ".clawdock", "config"), "utf8")).resolves.toBe(
            `CLAWDOCK_DIR="${projectDir}"\n`,
          );
        } finally {
          await rm(tempDir, { force: true, recursive: true });
        }
      },
    );
  }

  it("loads the standard docker-compose.override.yml before ClawDock extra overrides", async () => {
    const { tempDir, projectDir, binDir } = await createComposeSandbox();
    try {
      const argsFile = path.join(tempDir, "docker-args.txt");
      await writeFile(path.join(projectDir, "docker-compose.override.yml"), "services: {}\n");
      await writeFile(path.join(projectDir, "docker-compose.extra.yml"), "services: {}\n");
      await writeExecutable(
        path.join(binDir, "docker"),
        `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CLAWDOCK_DOCKER_ARGS_FILE"
`,
      );

      await execFileAsync(
        "bash",
        ["-c", "source scripts/clawdock/clawdock-helpers.sh; _clawdock_compose config"],
        {
          cwd: repoRoot,
          env: helperEnv({
            projectDir,
            binDir,
            homeDir: path.join(tempDir, "home"),
            extra: { CLAWDOCK_DOCKER_ARGS_FILE: argsFile },
          }),
        },
      );

      await expect(readFile(argsFile, "utf8")).resolves.toBe(
        [
          "compose",
          "-f",
          path.join(projectDir, "docker-compose.yml"),
          "-f",
          path.join(projectDir, "docker-compose.override.yml"),
          "-f",
          path.join(projectDir, "docker-compose.extra.yml"),
          "config",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("opens dashboard URLs through the published gateway port without starting dependencies", async () => {
    const { tempDir, projectDir, binDir } = await createComposeSandbox();
    try {
      const argsFile = path.join(tempDir, "docker-args.txt");
      const openedUrlFile = path.join(tempDir, "opened-url.txt");
      await writeExecutable(
        path.join(binDir, "docker"),
        `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$CLAWDOCK_DOCKER_ARGS_FILE"
printf '%s\\n' '---' >> "$CLAWDOCK_DOCKER_ARGS_FILE"
if [[ "$*" == *" port openclaw-gateway 18789" ]]; then
  printf '%s\\n' '0.0.0.0:19001'
else
  printf '%s\\n' 'Dashboard: http://127.0.0.1:18789/?token=test-token'
fi
`,
      );
      await writeExecutable(
        path.join(binDir, "open"),
        `#!/usr/bin/env bash
printf '%s\\n' "$1" > "$CLAWDOCK_OPENED_URL_FILE"
`,
      );

      await execFileAsync(
        "bash",
        ["-c", "source scripts/clawdock/clawdock-helpers.sh; clawdock-dashboard"],
        {
          cwd: repoRoot,
          env: helperEnv({
            projectDir,
            binDir,
            homeDir: path.join(tempDir, "home"),
            extra: {
              CLAWDOCK_DOCKER_ARGS_FILE: argsFile,
              CLAWDOCK_OPENED_URL_FILE: openedUrlFile,
            },
          }),
        },
      );

      await expect(readFile(openedUrlFile, "utf8")).resolves.toBe(
        "http://127.0.0.1:19001/?token=test-token\n",
      );
      await expect(readFile(argsFile, "utf8")).resolves.toBe(
        [
          "compose",
          "-f",
          path.join(projectDir, "docker-compose.yml"),
          "run",
          "--rm",
          "--no-deps",
          "openclaw-cli",
          "dashboard",
          "--no-open",
          "---",
          "compose",
          "-f",
          path.join(projectDir, "docker-compose.yml"),
          "port",
          "openclaw-gateway",
          "18789",
          "---",
          "",
        ].join("\n"),
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects op:// references for OP_SERVICE_ACCOUNT_TOKEN before Compose runs", async () => {
    const { tempDir, projectDir, binDir } = await createComposeSandbox();
    try {
      const logFile = path.join(tempDir, "docker.log");
      await writeFile(path.join(projectDir, "docker-compose.override.yml"), "services: {}\n");
      await writeFile(path.join(projectDir, "docker-compose.extra.yml"), "services: {}\n");
      await writeFile(path.join(projectDir, "docker-compose.op.yml"), "services: {}\n");
      await writeExecutable(
        path.join(binDir, "docker"),
        `#!/usr/bin/env bash
printf 'docker-called\\n' > "${logFile}"
`,
      );

      const result = await execFileAsync(
        "bash",
        ["-c", "source scripts/clawdock/clawdock-helpers.sh; clawdock-op-restart"],
        {
          cwd: repoRoot,
          env: helperEnv({
            projectDir,
            binDir,
            homeDir: path.join(tempDir, "home"),
            extra: { OP_SERVICE_ACCOUNT_TOKEN: "op://Vault/Item/credential" },
          }),
        },
      ).then(
        (value) => ({ status: 0, ...value }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({
          status: error.code ?? 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
        }),
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("must be the raw 1Password service account token");
      expect(result.stdout).toContain("op:// reference");
      expect(result.stdout).not.toContain("op://Vault/Item/credential");
      expect(result.stderr).toBe("");
      await expect(readFile(logFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("uses the OP Compose overlay and recreates the gateway so env changes apply", async () => {
    const { tempDir, projectDir, binDir } = await createComposeSandbox();
    try {
      const logFile = path.join(tempDir, "docker.log");
      await writeFile(path.join(projectDir, "docker-compose.extra.yml"), "services: {}\n");
      await writeFile(path.join(projectDir, "docker-compose.op.yml"), "services: {}\n");
      await writeExecutable(
        path.join(binDir, "docker"),
        `#!/usr/bin/env bash
printf 'OP=%s\\n' "\${OP_SERVICE_ACCOUNT_TOKEN:-}" >> "${logFile}"
printf '%q ' "$@" >> "${logFile}"
printf '\\n' >> "${logFile}"
`,
      );

      await execFileAsync(
        "bash",
        ["-c", "source scripts/clawdock/clawdock-helpers.sh; clawdock-op-restart"],
        {
          cwd: repoRoot,
          env: helperEnv({
            projectDir,
            binDir,
            homeDir: path.join(tempDir, "home"),
            extra: { OP_SERVICE_ACCOUNT_TOKEN: "raw-service-account-token" },
          }),
        },
      );

      const log = await readFile(logFile, "utf8");
      expect(log).toContain("OP=raw-service-account-token");
      expect(log).toContain("-f");
      expect(log).toContain("docker-compose.override.yml");
      expect(log).toContain("docker-compose.extra.yml");
      expect(log).toContain("docker-compose.op.yml");
      expect(log).toContain("up -d --force-recreate openclaw-gateway");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
