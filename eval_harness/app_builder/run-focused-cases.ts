import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { checkSyntax } from "../evaluator/skill_invocation/build_health/syntax_check.ts";
import {
  inside,
  type Case,
} from "../evaluator/skill_invocation/focused/cases.ts";
import {
  observeClaude,
  scoreRouting,
} from "../evaluator/skill_invocation/focused/trace.ts";
import {
  writeReport,
  type Attempt,
} from "../evaluator/skill_invocation/focused/report.ts";

const TOOLS = "Read,Glob,Grep,Skill,Write,Edit";
const SETTINGS = { disableAllHooks: true, enabledPlugins: {} };
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function hashTree(root: string): string {
  const files: string[] = [];
  function visit(dir: string) {
    for (const item of readdirSync(join(root, dir), {
      withFileTypes: true,
    }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if ([".git", "node_modules"].includes(item.name)) continue;
      const name = join(dir, item.name);
      if (item.isSymbolicLink())
        throw new Error(`Fixture/catalog symlinks are unsupported: ${name}`);
      if (item.isDirectory()) visit(name);
      else files.push(`${name}\0${sha(readFileSync(join(root, name)))}`);
    }
  }
  visit("");
  return sha(files.join("\n"));
}

export async function runFocusedCases(args: {
  cases: Case[];
  fixtures: string;
  plugin: string;
  out: string;
  model: string;
  repetitions: number;
  timeoutSeconds: number;
  maxTurns: number;
}): Promise<Attempt[]> {
  if (process.env.SKILL_EVAL_REMOTE !== "1" || !process.env.CI)
    throw new Error(
      "Agent evaluations run in CI only. Submit the focused EAS workflow; local validate/compare commands do not call a model.",
    );
  const runtime = Bun.spawnSync(["claude", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (runtime.exitCode !== 0) throw new Error("Claude CLI unavailable");
  const runtimeVersion = runtime.stdout.toString().trim();
  const attempts: Attempt[] = [];
  mkdirSync(args.out, { recursive: true });
  // Freeze the real plugin once, before attempts. Do not mutate or optimize it.
  const root = mkdtempSync(join(tmpdir(), "expo-focused-"));
  try {
    const plugin = join(root, "plugin");
    hashTree(args.plugin); // Reject symlinks before copying.
    cpSync(args.plugin, plugin, {
      recursive: true,
      filter: (source) => ![".git", "node_modules"].includes(basename(source)),
    });
    const pluginHash = hashTree(plugin);
    const bodies: Record<string, string> = {};
    for (const entry of readdirSync(join(plugin, "skills"), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const source = readFileSync(
        join(plugin, "skills", entry.name, "SKILL.md"),
        "utf8",
      );
      bodies[entry.name] = source
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
        .trim();
    }
    for (const item of args.cases) {
      const fixture = inside(args.fixtures, item.fixture);
      const fixtureHash = hashTree(fixture);
      for (let attempt = 1; attempt <= args.repetitions; attempt++) {
        const out = join(args.out, item.id, String(attempt));
        mkdirSync(out, { recursive: true });
        const home = mkdtempSync(join(root, "attempt-"));
        const workspace = join(home, "workspace");
        cpSync(fixture, workspace, {
          recursive: true,
          filter: (source) =>
            ![".git", "node_modules"].includes(basename(source)),
        });
        mkdirSync(join(home, "claude"));
        const config = {
          schema_version: 1,
          adapter: "claude-focused-v1",
          model: args.model,
          runtime: runtimeVersion,
          case: item,
          fixture_hash: fixtureHash,
          tools: TOOLS,
          settings: SETTINGS,
          mcp: "disabled",
          max_turns: args.maxTurns,
          timeout_seconds: args.timeoutSeconds,
        };
        const argv = [
          "claude",
          "-p",
          item.prompt,
          "--model",
          args.model,
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--max-turns",
          String(args.maxTurns),
          "--tools",
          TOOLS,
          "--allowedTools",
          TOOLS,
          "--setting-sources",
          "",
          "--settings",
          JSON.stringify(SETTINGS),
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--plugin-dir",
          plugin,
        ];
        const manifest = {
          ...config,
          plugin_hash: pluginHash,
          intended_skills: Object.keys(bodies),
          catalog_visibility: "not_verified",
          attempt,
          started_at: new Date().toISOString(),
        };
        writeFileSync(
          join(out, "manifest.json"),
          JSON.stringify(manifest, null, 2),
        );
        const stdout = openSync(join(out, "raw.jsonl"), "w");
        const stderr = openSync(join(out, "stderr.log"), "w");
        const start = Date.now();
        let exitCode: number | null = null;
        let timedOut = false;
        let launchError = "";
        const env: Record<string, string | undefined> = {
          ...process.env,
          CLAUDE_CONFIG_DIR: join(home, "claude"),
          CI: "1",
          EXPO_NO_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
        };
        delete env.CLAUDECODE;
        try {
          const child = Bun.spawn(argv, {
            cwd: workspace,
            env,
            stdin: "ignore",
            stdout,
            stderr,
          });
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, args.timeoutSeconds * 1000);
          try {
            exitCode = await child.exited;
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          launchError = String(error);
        } finally {
          closeSync(stdout);
          closeSync(stderr);
        }
        const observation = observeClaude(
          readFileSync(join(out, "raw.jsonl"), "utf8"),
          bodies,
        );
        if (exitCode !== 0 || timedOut || launchError) {
          observation.complete = false;
          observation.errors.push(
            launchError ||
              (timedOut ? "Agent timed out" : `Agent exited ${exitCode}`),
          );
        }
        const syntax = await checkSyntax(workspace);
        const checks: Attempt["checks"] = [
          {
            id: "source-syntax",
            status:
              syntax.ok === true
                ? "passed"
                : syntax.ok === false
                  ? "failed"
                  : "unavailable",
            evidence: JSON.stringify(syntax),
          },
        ];
        for (const file of item.unchanged) {
          let same = false;
          try {
            same = readFileSync(inside(fixture, file)).equals(
              readFileSync(inside(workspace, file)),
            );
          } catch {
            /* A removed file is a failed preservation check. */
          }
          checks.push({
            id: `preserve:${file}`,
            status: same ? "passed" : "failed",
            evidence: same
              ? "Original bytes preserved"
              : "File changed or removed",
          });
        }
        for (const assertion of item.review)
          checks.push({
            id: "human-review",
            status: "pending",
            evidence: assertion,
          });
        cpSync(workspace, join(out, "app"), { recursive: true });
        writeFileSync(join(out, "final.txt"), observation.final);
        const run: Attempt = {
          id: item.id,
          family: item.family,
          attempt,
          condition: sha(
            JSON.stringify({ ...config, resolved_model: observation.model }),
          ),
          plugin_hash: pluginHash,
          status: observation.complete ? "complete" : "infrastructure_error",
          duration_ms: Date.now() - start,
          routing: scoreRouting(item.expect, observation, item.before_edit),
          checks,
          observation,
        };
        attempts.push(run);
        writeReport(args.out, attempts); // Preserve completed attempts if a later run fails.
        console.log(`${item.id} ${attempt}/${args.repetitions}: ${run.status}`);
        rmSync(home, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return attempts;
}
