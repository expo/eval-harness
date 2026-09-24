import { SIGNING_CASE, signingContext } from "../evaluator/skill_invocation/focused/signing-case.ts";
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

import { checkOutcomes } from "../evaluator/skill_invocation/focused/outcomes.ts";

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
  skillMode?: "with-expo" | "without-expo" | "both";
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
    cpSync(plugin, join(args.out, "catalog"), { recursive: true });
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
    if (!Object.keys(bodies).length) throw new Error("Expo plugin has no skills");
    for (const item of args.cases) {
      const fixture = inside(args.fixtures, item.fixture);
      const fixtureHash = hashTree(fixture);
      for (let attempt = 1; attempt <= args.repetitions; attempt++) {
        const modes: Array<"with-expo" | "without-expo"> =
          args.skillMode === "both"
            ? attempt % 2
              ? ["without-expo", "with-expo"]
              : ["with-expo", "without-expo"]
            : [args.skillMode ?? "with-expo"];
        for (const mode of modes) {
          const modeRoot =
            args.skillMode === "both" ? join(args.out, mode) : args.out;
          const out = join(modeRoot, item.id, String(attempt));
          mkdirSync(out, { recursive: true });
          const home = mkdtempSync(join(root, "attempt-"));
          const workspace = join(home, "workspace");
          const attemptPlugin = join(home, "plugin");
          if (mode === "with-expo")
            cpSync(plugin, attemptPlugin, { recursive: true });
          cpSync(fixture, workspace, {
            recursive: true,
            filter: (source) =>
              ![".git", "node_modules"].includes(basename(source)),
          });
          mkdirSync(join(home, "claude"));
          const config = {
            schema_version: 1,
            adapter: "claude-focused-v2",
            harness_hash: sha(
              hashTree(
                join(import.meta.dir, "../evaluator/skill_invocation/focused"),
              ) + sha(readFileSync(import.meta.filename)),
            ),
            verifier_node: Bun.spawnSync(["node", "--version"])
              .stdout.toString()
              .trim(),
            verifier_lock_hash: sha(
              readFileSync(join(import.meta.dir, "../../bun.lock")),
            ),
            model: args.model,
            runtime: runtimeVersion,
            case: item,
            fixture_hash: fixtureHash,
            ...(item.id === SIGNING_CASE.id
              ? { signing_context: signingContext(item, fixture) }
              : {}),
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
            ...(mode === "with-expo" ? ["--plugin-dir", attemptPlugin] : []),
          ];
          const manifest = {
            ...config,
            skill_mode: mode,
            plugin_hash: mode === "with-expo" ? pluginHash : null,
            intended_skills: mode === "with-expo" ? Object.keys(bodies) : [],
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
          if (
            mode === "without-expo" &&
            (observation.advertised_skills === null ||
              observation.advertised_skills.some(
                (name) =>
                  name.startsWith("expo:") || Object.hasOwn(bodies, name),
              ) ||
              observation.events.some(
                (event) =>
                  event.kind === "delivered" &&
                  event.skill &&
                  bodies[event.skill],
              ))
          ) {
            observation.complete = false;
            observation.errors.push(
              "Without-Expo catalog absence is unverified or Expo skills were exposed",
            );
          }
          if (mode === "with-expo") {
            const advertised = observation.advertised_skills;
            const missing = Object.keys(bodies).filter(
              (name) =>
                !advertised?.includes(`expo:${name}`) && !advertised?.includes(name),
            );
            if (!advertised || missing.length) {
              observation.complete = false;
              observation.errors.push(
                `With-Expo catalog registration is unverified; ${advertised ? `missing skills: ${missing.join(", ")}` : "init skill list unavailable"}`,
              );
            }
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
          checks.push(...(await checkOutcomes(item, fixture, workspace)));
          for (const check of checks.filter(
            (check) =>
              item.checks?.includes(
                check.id as NonNullable<Case["checks"]>[number],
              ) && check.status === "unavailable",
          )) {
            observation.complete = false;
            observation.errors.push(check.evidence);
          }
          for (const [index, assertion] of item.review.entries())
            checks.push({
              id: `review:${index + 1}`,
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
            skill_mode: mode,
            artifact_path:
              args.skillMode === "both"
                ? `${mode}/${item.id}/${attempt}`
                : `${item.id}/${attempt}`,
            plugin_hash: mode === "with-expo" ? pluginHash : "absent",
            status: observation.complete ? "complete" : "infrastructure_error",
            duration_ms: Date.now() - start,
            routing:
              mode === "with-expo"
                ? scoreRouting(item.expect, observation, item.before_edit)
                : [],
            checks,
            observation,
          };
          attempts.push(run);
          writeReport(args.out, attempts); // Preserve completed attempts if a later run fails.
          console.log(
            `${item.id} ${mode} ${attempt}/${args.repetitions}: ${run.status}`,
          );
          rmSync(home, { recursive: true, force: true });
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return attempts;
}
