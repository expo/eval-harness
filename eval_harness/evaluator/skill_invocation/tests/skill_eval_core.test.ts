import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { c as createArchive } from "tar";

import {
  appNameFromPrd,
  dedupe,
  extractTar,
  firstArchive,
  flattenStrings,
  loadPrdSkills,
  readJson,
  unpackArtifact,
  writeJson,
} from "../utils.ts";
import {
  computeBundleResult,
  persistBundleResult,
  readBundleResult,
} from "../build_health/bundle_check.ts";
import {
  checkFileSyntax,
  extractAstFacts,
} from "../build_health/node_parser.ts";
import { checkSyntax } from "../build_health/syntax_check.ts";
import {
  detectTriggeredSkills,
  scoreTriggerQuality,
  type NormalizedTrace,
} from "../uptake_checks/trigger.ts";
import {
  CheckResult,
  UptakeResults,
  allChecks,
  loadChecksData,
  loadSkillMap,
  resolveChecksBySkill,
  resolveChecksForSkills,
  runChecks,
  type CheckDefinition,
  type CheckStatus,
} from "../uptake_checks/index.ts";

const REAL_CHECKS_DIR = resolve(import.meta.dir, "../uptake_checks");
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const PYTHON = existsSync(join(REPO_ROOT, ".venv", "bin", "python"))
  ? join(REPO_ROOT, ".venv", "bin", "python")
  : Bun.which("python3");

function withTempDir<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "skill-core-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeChecksDir(
  root: string,
  checks: CheckDefinition[],
  skillMap: Record<string, string[]>,
): string {
  const checksDir = join(root, "uptake_checks");
  mkdirSync(checksDir, { recursive: true });
  writeFileSync(
    join(checksDir, "checks_data.json"),
    JSON.stringify({ checks }),
  );
  writeFileSync(join(checksDir, "skill_map.json"), JSON.stringify(skillMap));
  return checksDir;
}

function trace(
  agent: string,
  toolCallsByStep: Array<Array<Record<string, unknown>>>,
): NormalizedTrace {
  return {
    agent,
    sessions: [
      {
        turns: [
          {
            steps: toolCallsByStep.map((toolCalls) => ({ tool_calls: toolCalls })),
          },
        ],
      },
    ],
  };
}

function writeAppFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
}

function runRealChecks(
  root: string,
  skillId: string,
): Record<string, CheckResult> {
  const { checks } = resolveChecksForSkills([skillId], REAL_CHECKS_DIR);
  return Object.fromEntries(
    runChecks(checks, root).map((result) => [result.id, result]),
  );
}

test("[SPEC SKILL-001] each skill resolves to exactly its declared checks", () => {
  // Property: every supported skill receives exactly its mapped checks, while
  // an absent skill remains explicitly unsupported.
  // Oracle: the generated skill-map arrays themselves.
  // Catches: cross-skill leakage, reordering, dropped checks, and empty-list
  // representations that hide an unsupported skill.
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.constantFrom("check-a", "check-b", "check-c")),
      fc.uniqueArray(fc.constantFrom("mapped-skill", "unsupported-skill")),
      (mappedCheckIds, expectedSkills) => {
        withTempDir((root) => {
          const checksDir = writeChecksDir(
            root,
            ["check-a", "check-b", "check-c"].map((id) => ({
              id,
              category: "structural",
              kind: "path_exists",
              target: [id],
            })),
            { "mapped-skill": mappedCheckIds },
          );

          const { checksBySkill, warnings } = resolveChecksBySkill(
            expectedSkills,
            checksDir,
          );
          const actualIds = Object.fromEntries(
            Object.entries(checksBySkill).map(([skillId, checks]) => [
              skillId,
              checks?.map((check) => check.id) ?? null,
            ]),
          );
          const expectedIds = Object.fromEntries(
            expectedSkills.map((skillId) => [
              skillId,
              skillId === "mapped-skill" ? mappedCheckIds : null,
            ]),
          );

          expect(actualIds).toEqual(expectedIds);
          expect(warnings).toEqual(
            expectedSkills
              .filter((skillId) => skillId === "unsupported-skill")
              .map(
                () =>
                  "no uptake checks mapped for skill 'unsupported-skill'",
              ),
          );
        });
      },
    ),
  );
});

const STATUS_AND_PASS = [
  ["passed", true],
  ["failed", false],
  ["not_applicable", null],
  ["unavailable", null],
] as const satisfies ReadonlyArray<readonly [CheckStatus, boolean | null]>;

test("[SPEC SKILL-002] only scored statuses affect uptake", () => {
  // Property: passed/failed results alone affect counts, rates, and category
  // breakdowns; every generated result remains visible.
  // Oracle: direct counts over independently generated status labels.
  // Catches: unavailable/not-applicable denominator inflation and category
  // totals that disagree with the aggregate.
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.constantFrom(...STATUS_AND_PASS),
          fc.constantFrom("lexical", "structural", "syntax-tree"),
        ),
        { maxLength: 50 },
      ),
      (records) => {
        const results = new UptakeResults(
          records.map(
            ([[status, passed], category], index) =>
              new CheckResult({
                id: `check-${index}`,
                category,
                kind: "generated",
                target: null,
                passed,
                evidence: "generated",
                status,
              }),
          ),
        );
        const scored = records.filter(([[status]]) =>
          status === "passed" || status === "failed"
        );
        const expectedPassed = scored.filter(
          ([[status]]) => status === "passed",
        ).length;
        const expectedBreakdown: Record<
          string,
          { passed: number; total: number }
        > = {};
        for (const [[status], category] of scored) {
          const bucket = expectedBreakdown[category] ?? {
            passed: 0,
            total: 0,
          };
          bucket.total += 1;
          if (status === "passed") bucket.passed += 1;
          expectedBreakdown[category] = bucket;
        }

        expect(results.passed).toBe(expectedPassed);
        expect(results.total).toBe(scored.length);
        expect(results.categoryBreakdown()).toEqual(expectedBreakdown);
        expect(results.uptakeRate).toBe(
          scored.length === 0
            ? null
            : Math.round((expectedPassed / scored.length) * 10_000) / 10_000,
        );
        expect(results.checks).toHaveLength(records.length);
      },
    ),
  );
});

test("[SPEC SKILL-003] trigger quality partitions skill sets", () => {
  // Property: stable unique expected/observed IDs are partitioned exactly into
  // matched, missing, and extra skills with bounded recall and precision.
  // Oracle: JavaScript Set arithmetic over the generated IDs.
  // Catches: duplicate inflation, reversed denominators, and missing extras.
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 12 }),
      fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 12 }),
      (expected, triggered) => {
        const expectedUnique = [...new Set(expected)];
        const triggeredUnique = [...new Set(triggered)];
        const expectedSet = new Set(expectedUnique);
        const triggeredSet = new Set(triggeredUnique);
        const matched = expectedUnique.filter((skill) =>
          triggeredSet.has(skill)
        );
        const missing = expectedUnique.filter((skill) =>
          !triggeredSet.has(skill)
        );
        const extra = triggeredUnique.filter((skill) =>
          !expectedSet.has(skill)
        );
        const result = scoreTriggerQuality(expected, triggered);

        expect(result.expectedSkills).toEqual(expectedUnique);
        expect(result.triggeredSkills).toEqual(triggeredUnique);
        expect(result.matchedSkills).toEqual(matched);
        expect(result.missingSkills).toEqual(missing);
        expect(result.extraSkills).toEqual(extra);
        expect(result.recall).toBe(
          expectedUnique.length === 0
            ? 1
            : Math.round((matched.length / expectedUnique.length) * 10_000) /
                10_000,
        );
        expect(result.precision).toBe(
          triggeredUnique.length === 0
            ? expectedUnique.length === 0
              ? 1
              : 0
            : Math.round((matched.length / triggeredUnique.length) * 10_000) /
                10_000,
        );
        expect(result.recall).toBeGreaterThanOrEqual(0);
        expect(result.recall).toBeLessThanOrEqual(1);
        expect(result.precision).toBeGreaterThanOrEqual(0);
        expect(result.precision).toBeLessThanOrEqual(1);
      },
    ),
  );
});

test("[SPEC] stable deduplication preserves first occurrences", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 40 }), (values) => {
      expect(dedupe(values)).toEqual([...new Set(values)]);
    }),
  );
});

test("[SPEC] flattenStrings preserves nested visit order", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), fc.string(), (left, right, tail) => {
      expect(
        flattenStrings({ outer: [left, { inner: right }], tail: [tail] }),
      ).toEqual(["outer", left, "inner", right, "tail", tail]);
    }),
  );
});

test("[REGRESSION] PRD app names preserve Python path behavior", () => {
  expect(appNameFromPrd("dataset/prds/notes/prd/mvp.txt")).toBe("notes");
  expect(appNameFromPrd("some/other/path.txt")).toBeNull();
});

test("[REGRESSION] JSON helpers preserve sorted output and PRD skill arrays", () => {
  withTempDir((root) => {
    const path = join(root, "prd_skills.json");
    writeJson(
      {
        zebra: ["expo-ui"],
        alpha: { nested_z: 2, nested_a: 1 },
      },
      path,
    );

    expect(readFileSync(path, "utf8")).toBe(
      '{\n  "alpha": {\n    "nested_a": 1,\n    "nested_z": 2\n  },\n  "zebra": [\n    "expo-ui"\n  ]\n}\n',
    );
    expect(readJson<Record<string, unknown>>(path)).toEqual({
      alpha: { nested_a: 1, nested_z: 2 },
      zebra: ["expo-ui"],
    });
    const skillsPath = join(root, "skills-only.json");
    writeFileSync(skillsPath, '{"notes":["expo-ui","expo-router"]}');
    expect(loadPrdSkills(skillsPath)).toEqual({
      notes: ["expo-ui", "expo-router"],
    });
  });
});

test("[REGRESSION] Claude and Codex trigger detection uses structured calls", () => {
  expect(
    detectTriggeredSkills(
      trace("claude-code", [
        [{ name: "Skill", args: { skill: "expo:expo-router" } }],
      ]),
    ),
  ).toEqual(["expo-router"]);
  expect(
    detectTriggeredSkills(
      trace("codex", [
        [
          {
            name: "exec_command",
            args: { cmd: "cat .agents/skills/expo-ui/SKILL.md" },
          },
        ],
      ]),
    ),
  ).toEqual(["expo-ui"]);
  expect(
    detectTriggeredSkills(
      trace("codex", [
        [
          {
            name: "exec_command",
            args: { cmd: "npm install", output: "mentions expo-router" },
          },
        ],
      ]),
    ),
  ).toEqual([]);
});

test("[REGRESSION] real check data and skill mappings remain internally valid", () => {
  const dataChecks = loadChecksData(REAL_CHECKS_DIR);
  const skillMap = loadSkillMap(REAL_CHECKS_DIR);
  const registry = allChecks(REAL_CHECKS_DIR);

  expect(dataChecks.has("router_navigation_api_used")).toBe(true);
  expect(skillMap["expo-router"]).toContain("router_app_dir_exists");
  expect(skillMap["expo-project-structure"]).toContain(
    "router_app_dir_exists",
  );
  for (const checkIds of Object.values(skillMap)) {
    for (const checkId of checkIds) expect(registry.has(checkId)).toBe(true);
  }
});

test("[REGRESSION] pooled resolution deduplicates shared checks", () => {
  withTempDir((root) => {
    const checksDir = writeChecksDir(
      root,
      [
        {
          id: "shared",
          category: "structural",
          kind: "path_exists",
          target: ["app"],
        },
        {
          id: "router-only",
          category: "lexical",
          kind: "import",
          target: "expo-router",
        },
      ],
      { "skill-a": ["shared", "router-only"], "skill-b": ["shared"] },
    );
    const { checks, warnings } = resolveChecksForSkills(
      ["skill-a", "skill-b"],
      checksDir,
    );
    expect(warnings).toEqual([]);
    expect(checks.map((check) => check.id)).toEqual(["shared", "router-only"]);
  });
});

test("[REGRESSION] declarative checks ignore comments and tooling directories", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "app"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(
      join(root, "app", "index.tsx"),
      "// import { Stack } from 'expo-router';\nexport default null;\n",
    );
    writeFileSync(
      join(root, "scripts", "reset-project.js"),
      "import { Stack } from 'expo-router';\n",
    );
    const checksDir = writeChecksDir(
      join(root, "checks"),
      [
        {
          id: "router-import",
          category: "lexical",
          kind: "import",
          target: "expo-router",
        },
        {
          id: "app-exists",
          category: "structural",
          kind: "path_exists",
          target: ["app"],
        },
      ],
      { "expo-router": ["router-import", "app-exists"] },
    );
    const { checks } = resolveChecksForSkills(["expo-router"], checksDir);
    const results = Object.fromEntries(
      runChecks(checks, root).map((result) => [result.id, result]),
    );

    expect(results["router-import"]?.status).toBe("failed");
    expect(results["app-exists"]?.status).toBe("passed");
  });
});

test("[REGRESSION] every declarative check kind preserves its basic result", () => {
  withTempDir((root) => {
    writeAppFiles(root, {
      "app/index.tsx":
        "const loading = true; const ready = true; export default loading && ready;\n",
      "package.json": JSON.stringify({
        dependencies: { "runtime-package": "1.0.0" },
        devDependencies: { "development-package": "1.0.0" },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./*"] } },
      }),
    });
    const checksDir = writeChecksDir(
      join(root, "checks"),
      [
        { id: "text", category: "lexical", kind: "text", target: "loading" },
        {
          id: "text-any",
          category: "lexical",
          kind: "text_any",
          target: ["missing", "ready"],
        },
        {
          id: "text-absent",
          category: "lexical",
          kind: "text_absent",
          target: "forbidden",
        },
        {
          id: "runtime-dependency",
          category: "structural",
          kind: "package_dependency",
          target: "runtime-package",
        },
        {
          id: "development-dependency",
          category: "structural",
          kind: "package_dependency",
          target: "development-package",
        },
        {
          id: "path-alias",
          category: "structural",
          kind: "tsconfig_path_alias",
          target: "@/*",
        },
      ],
      {
        "all-kinds": [
          "text",
          "text-any",
          "text-absent",
          "runtime-dependency",
          "development-dependency",
          "path-alias",
        ],
      },
    );
    const { checks } = resolveChecksForSkills(["all-kinds"], checksDir);
    const results = runChecks(checks, root);

    expect(results.map((result) => result.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
  });
});

test("[SPEC SKILL-004] parent traversal cannot escape artifact extraction", () => {
  // Property: extraction never creates or changes a path outside its requested
  // destination.
  // Oracle: the deliberately archived ../ path resolves outside the destination
  // and its pre-existing source content remains unchanged after rejection.
  // Catches: parent-directory traversal and warning-only extraction behavior.
  withTempDir((root) => {
    const source = join(root, "source");
    const payload = join(root, "outside.txt");
    const archive = join(root, "unsafe.tar");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(payload, "outside remains unchanged");
    createArchive(
      {
        file: archive,
        cwd: source,
        sync: true,
        preservePaths: true,
      },
      ["../outside.txt"],
    );

    expect(() => extractTar(archive, destination)).toThrow();
    expect(readFileSync(payload, "utf8")).toBe("outside remains unchanged");
    expect(existsSync(join(destination, "outside.txt"))).toBe(false);
  });
});

test("[SPEC SKILL-004] external symbolic-link targets are rejected", () => {
  // Property: extraction never follows an archive link outside its destination.
  // Oracle: the generated link target is independently known to be ../outside.
  // Catches: validating member names while ignoring link targets.
  withTempDir((root) => {
    const source = join(root, "source");
    const outside = join(root, "outside");
    const archive = join(root, "unsafe-link.tar");
    const destination = join(root, "destination");
    mkdirSync(source);
    mkdirSync(outside);
    symlinkSync("../outside", join(source, "link"));
    createArchive({ file: archive, cwd: source, sync: true }, ["link"]);

    expect(() => extractTar(archive, destination)).toThrow();
    expect(existsSync(join(destination, "link"))).toBe(false);
  });
});

test("[REGRESSION] valid compressed artifacts unpack into the destination", () => {
  withTempDir((root) => {
    const source = join(root, "source");
    const archive = join(root, "artifact.tar.gz");
    const destination = join(root, "destination");
    mkdirSync(join(source, "bundle"), { recursive: true });
    writeFileSync(join(source, "bundle", "manifest.json"), '{"prd":"notes"}');
    createArchive(
      { file: archive, cwd: source, sync: true, gzip: true },
      ["bundle"],
    );

    expect(unpackArtifact(archive, destination)).toBe(destination);
    expect(existsSync(join(destination, "bundle", "manifest.json"))).toBe(true);
  });
});

test("[REGRESSION] directory artifacts prefer compressed archives before plain tar", () => {
  withTempDir((root) => {
    const archiveDirectory = join(root, "archives");
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(archiveDirectory);
    mkdirSync(source);
    writeFileSync(join(source, "selected.txt"), "compressed");
    createArchive(
      {
        file: join(archiveDirectory, "z-selected.tar.gz"),
        cwd: source,
        sync: true,
        gzip: true,
      },
      ["selected.txt"],
    );
    writeFileSync(join(archiveDirectory, "a-ignored.tar"), "not a tar");

    expect(firstArchive(archiveDirectory)).toBe(
      join(archiveDirectory, "z-selected.tar.gz"),
    );
    expect(unpackArtifact(archiveDirectory, destination)).toBe(destination);
    expect(readFileSync(join(destination, "selected.txt"), "utf8")).toBe(
      "compressed",
    );
  });
});

test("[REGRESSION] Babel syntax checks distinguish valid and broken source", () => {
  withTempDir((root) => {
    const valid = join(root, "valid.tsx");
    const broken = join(root, "broken.tsx");
    writeFileSync(valid, "export default function App(){ return <View />; }\n");
    writeFileSync(broken, "export default function Broken(){ return <View\n");

    expect(checkFileSyntax(valid)).toEqual({ ok: true });
    expect(checkFileSyntax(broken)).toMatchObject({ error: "parse_error" });
    const result = checkSyntax(root);
    expect(result.total_files).toBe(2);
    expect(result.checked_files).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.failed_files.map((item) => item.file)).toEqual(["broken.tsx"]);
  });
});

test("[REGRESSION] AST facts recognize directives, exports, and namespace JSX", () => {
  withTempDir((root) => {
    const path = join(root, "map.tsx");
    writeFileSync(
      path,
      "'use dom';\n" +
        "import * as RN from 'react-native';\n" +
        "export default function Map(){ return <RN.Text>hi</RN.Text>; }\n",
    );

    expect(extractAstFacts(path)).toEqual({
      ok: true,
      hasUseDomDirective: true,
      defaultExportCount: 1,
      reactNativeJsxElementsUsed: ["RN.Text"],
    });
  });
});

test("[REGRESSION] real DOM checks use AST-backed applicability and failures", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "app"));
    mkdirSync(join(root, "components"));
    writeFileSync(
      join(root, "app", "_layout.tsx"),
      "import { Stack } from 'expo-router'; export default Stack;\n",
    );
    writeFileSync(
      join(root, "components", "map.tsx"),
      "'use dom';\nimport * as RN from 'react-native';\n" +
        "export default function Map(){ return <RN.Text>hi</RN.Text>; }\n",
    );
    const { checks } = resolveChecksForSkills(["expo-dom"], REAL_CHECKS_DIR);
    const results = Object.fromEntries(
      runChecks(checks, root).map((result) => [result.id, result]),
    );

    expect(results["dom_use_dom_directive_present"]?.status).toBe("passed");
    expect(results["dom_layout_excludes_use_dom"]?.status).toBe("passed");
    expect(
      results["dom_single_default_export_and_no_native_jsx"]?.status,
    ).toBe("failed");
    expect(
      results["dom_single_default_export_and_no_native_jsx"]?.evidence,
    ).toContain("RN.Text");
  });
});

test("[REGRESSION] feature-specific anti-pattern checks do not vacuously pass", () => {
  withTempDir((root) => {
    writeFileSync(
      join(root, "index.tsx"),
      "import { SafeAreaProvider } from 'react-native-safe-area-context';\n" +
        "export default SafeAreaProvider;\n",
    );
    const { checks } = resolveChecksForSkills(
      ["expo-native-ui"],
      REAL_CHECKS_DIR,
    );
    const results = Object.fromEntries(
      runChecks(checks, root).map((result) => [result.id, result]),
    );

    expect(results["native_ui_no_safe_area_view_from_react_native"]?.status).toBe(
      "passed",
    );
    expect(results["native_ui_no_expo_av"]?.status).toBe("not_applicable");
    expect(results["native_ui_no_dimensions_get"]?.status).toBe(
      "not_applicable",
    );
  });
});

test("[REGRESSION] server secrets are excluded from client env-prefix checks", () => {
  withTempDir((root) => {
    mkdirSync(join(root, "app", "api"), { recursive: true });
    writeFileSync(
      join(root, "app", "api", "secret+api.ts"),
      "export const key = process.env.OPENAI_API_KEY;\n",
    );
    const { checks } = resolveChecksForSkills(
      ["expo-data-fetching"],
      REAL_CHECKS_DIR,
    );
    const results = Object.fromEntries(
      runChecks(checks, root).map((result) => [result.id, result]),
    );

    expect(results["data_fetching_expo_public_env_prefix"]?.status).toBe(
      "not_applicable",
    );
  });
});

test("[REGRESSION] code-driven checks preserve applicability and violation rules", () => {
  const cases: Array<{
    name: string;
    skillId: string;
    files: Record<string, string>;
    expected: Record<string, CheckStatus>;
  }> = [
    {
      name: "expo-ui subpackage Host import",
      skillId: "expo-ui",
      files: {
        "index.tsx": "import { Host } from '@expo/ui/swift-ui'; export default Host;\n",
      },
      expected: { expo_ui_no_host_from_subpackage: "failed" },
    },
    {
      name: "expo-ui absent engagement",
      skillId: "expo-ui",
      files: { "index.tsx": "export default null;\n" },
      expected: {
        expo_ui_no_host_from_subpackage: "not_applicable",
        expo_ui_platform_specific_trees_not_in_app_dir: "not_applicable",
      },
    },
    {
      name: "expo-ui route platform extension",
      skillId: "expo-ui",
      files: {
        "app/widget.ios.tsx": "import { Host } from '@expo/ui'; export default Host;\n",
      },
      expected: {
        expo_ui_platform_specific_trees_not_in_app_dir: "failed",
      },
    },
    {
      name: "axios violation",
      skillId: "expo-data-fetching",
      files: { "index.ts": "import axios from 'axios'; export default axios;\n" },
      expected: { data_fetching_no_axios: "failed" },
    },
    {
      name: "data-fetching absent engagement",
      skillId: "expo-data-fetching",
      files: { "index.ts": "export const value = 1;\n" },
      expected: { data_fetching_no_axios: "not_applicable" },
    },
    {
      name: "client environment prefix violation",
      skillId: "expo-data-fetching",
      files: { "index.ts": "export const key = process.env.SECRET;\n" },
      expected: { data_fetching_expo_public_env_prefix: "failed" },
    },
    {
      name: "removed expo-av import",
      skillId: "expo-native-ui",
      files: { "index.ts": "import { Audio } from 'expo-av'; export default Audio;\n" },
      expected: { native_ui_no_expo_av: "failed" },
    },
    {
      name: "modern audio engagement",
      skillId: "expo-native-ui",
      files: { "index.ts": "import { useAudioPlayer } from 'expo-audio'; export default useAudioPlayer;\n" },
      expected: { native_ui_no_expo_av: "passed" },
    },
    {
      name: "Dimensions.get violation",
      skillId: "expo-native-ui",
      files: { "index.ts": "export const size = Dimensions.get('window');\n" },
      expected: { native_ui_no_dimensions_get: "failed" },
    },
    {
      name: "react-native SafeAreaView violation",
      skillId: "expo-native-ui",
      files: { "index.ts": "import { SafeAreaView } from 'react-native'; export default SafeAreaView;\n" },
      expected: { native_ui_no_safe_area_view_from_react_native: "failed" },
    },
    {
      name: "direct React Navigation import",
      skillId: "expo-router",
      files: { "index.ts": "import { useFocusEffect } from '@react-navigation/native';\n" },
      expected: { router_no_direct_react_navigation_import: "failed" },
    },
    {
      name: "routing absent engagement",
      skillId: "expo-router",
      files: { "index.ts": "export const value = 1;\n" },
      expected: { router_no_direct_react_navigation_import: "not_applicable" },
    },
    {
      name: "banned Node import in API route",
      skillId: "eas-hosting",
      files: { "app/users+api.ts": "import fs from 'fs'; export const GET = fs.stat;\n" },
      expected: { hosting_no_banned_node_imports_in_api_routes: "failed" },
    },
    {
      name: "JavaScript API route",
      skillId: "eas-hosting",
      files: { "app/users+api.jsx": "export function GET(){ return Response.json({}); }\n" },
      expected: { hosting_api_routes_use_typescript: "failed" },
    },
    {
      name: "hosting absent API routes",
      skillId: "eas-hosting",
      files: { "app/index.tsx": "export default null;\n" },
      expected: {
        hosting_no_banned_node_imports_in_api_routes: "not_applicable",
        hosting_api_routes_use_typescript: "not_applicable",
      },
    },
  ];

  for (const testCase of cases) {
    withTempDir((root) => {
      writeAppFiles(root, testCase.files);
      const results = runRealChecks(root, testCase.skillId);
      for (const [checkId, expectedStatus] of Object.entries(
        testCase.expected,
      )) {
        expect(results[checkId]?.status, `${testCase.name}: ${checkId}`).toBe(
          expectedStatus,
        );
      }
    });
  }
});

test("[REGRESSION] DOM checks distinguish missing, malformed, layout, and export states", () => {
  const cases: Array<{
    name: string;
    files: Record<string, string>;
    expected: Record<string, CheckStatus>;
  }> = [
    {
      name: "no DOM component",
      files: { "app/index.tsx": "export default null;\n" },
      expected: {
        dom_use_dom_directive_present: "failed",
        dom_layout_excludes_use_dom: "not_applicable",
        dom_single_default_export_and_no_native_jsx: "not_applicable",
      },
    },
    {
      name: "malformed DOM layout",
      files: { "app/_layout.tsx": "'use dom'; export default function Layout(){ return <div" },
      expected: {
        dom_use_dom_directive_present: "unavailable",
        dom_layout_excludes_use_dom: "unavailable",
        dom_single_default_export_and_no_native_jsx: "unavailable",
      },
    },
    {
      name: "DOM directive in layout",
      files: { "app/_layout.tsx": "'use dom'; export default function Layout(){ return <div />; }\n" },
      expected: {
        dom_use_dom_directive_present: "passed",
        dom_layout_excludes_use_dom: "failed",
        dom_single_default_export_and_no_native_jsx: "passed",
      },
    },
    {
      name: "DOM component without default export",
      files: { "components/map.tsx": "'use dom'; export function Map(){ return <div />; }\n" },
      expected: {
        dom_layout_excludes_use_dom: "not_applicable",
        dom_single_default_export_and_no_native_jsx: "failed",
      },
    },
  ];

  for (const testCase of cases) {
    withTempDir((root) => {
      writeAppFiles(root, testCase.files);
      const results = runRealChecks(root, "expo-dom");
      for (const [checkId, expectedStatus] of Object.entries(
        testCase.expected,
      )) {
        expect(results[checkId]?.status, `${testCase.name}: ${checkId}`).toBe(
          expectedStatus,
        );
      }
    });
  }
});

test("[REGRESSION] bundle checks preserve unknown, failure, and persistence behavior", () => {
  withTempDir((root) => {
    expect(computeBundleResult(root)).toEqual({
      ok: null,
      reason: "no node_modules/.bin/expo in workspace",
    });
    expect(readBundleResult(root)).toBeNull();
    const persisted = persistBundleResult(root);
    expect(readBundleResult(root)).toEqual(persisted);

    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const fakeExpo = join(binDir, "expo");
    writeFileSync(fakeExpo, "#!/bin/sh\necho boom >&2\nexit 1\n");
    chmodSync(fakeExpo, 0o755);
    const failed = computeBundleResult(root);
    expect(failed.ok).toBe(false);
    expect(failed.reason).toContain("boom");

    writeFileSync(join(root, ".eval-build-health-bundle.json"), "not json");
    expect(readBundleResult(root)).toBeNull();

    writeFileSync(fakeExpo, "#!/bin/sh\nmkdir -p \"$5\"\nexit 0\n");
    chmodSync(fakeExpo, 0o755);
    expect(computeBundleResult(root)).toEqual({ ok: true });
    expect(existsSync(join(root, ".eval-bundle-export-tmp"))).toBe(false);
  });
});

test.skipIf(PYTHON === null)(
  "[DIFF] registry and code-check results match Python",
  () => {
    // Differential oracle: Python and TypeScript receive the same authored-app
    // tree, real registry, and expected skills; every observable check result
    // must match exactly while both implementations coexist.
    withTempDir((root) => {
      mkdirSync(join(root, "app", "api"), { recursive: true });
      mkdirSync(join(root, "components"));
      mkdirSync(join(root, "targets", "clip"), { recursive: true });
      mkdirSync(join(root, "public", ".well-known"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          dependencies: {
            "@expo/ui": "1.0.0",
            "expo-router": "1.0.0",
          },
        }),
      );
      writeFileSync(
        join(root, "app", "_layout.tsx"),
        "import { Stack } from 'expo-router';\n" +
          "export default function Layout(){ return <Stack />; }\n",
      );
      writeFileSync(
        join(root, "app", "index.tsx"),
        "import { Host } from '@expo/ui';\n" +
          "import { useWindowDimensions } from 'react-native';\n" +
          "const url = process.env.EXPO_PUBLIC_API_URL;\n" +
          "export default function App(){ useWindowDimensions(); fetch(url); return <Host />; }\n",
      );
      writeFileSync(
        join(root, "app", "api", "users+api.ts"),
        "export function GET(){ return Response.json({ ok: true }); }\n",
      );
      writeFileSync(
        join(root, "public", ".well-known", "apple-app-site-association"),
        "{}",
      );

      const expectedSkills = [
        "expo-router",
        "expo-project-structure",
        "expo-native-ui",
        "expo-ui",
        "expo-data-fetching",
        "eas-hosting",
        "expo-app-clip",
      ];
      const { checks, warnings } = resolveChecksForSkills(
        expectedSkills,
        REAL_CHECKS_DIR,
      );
      const typescriptPayload = {
        check_ids: checks.map((check) => check.id),
        warnings,
        results: runChecks(checks, root).map((result) => ({
          id: result.id,
          category: result.category,
          kind: result.kind,
          target: result.target,
          passed: result.passed,
          evidence: result.evidence,
          status: result.status,
        })),
      };
      const pythonScript = `
import json
import sys
from pathlib import Path
from eval_harness.evaluator.skill_invocation.uptake_checks.registry import resolve_checks_for_skills, run_checks

app_dir = Path(sys.argv[1])
checks_dir = Path(sys.argv[2])
skills = json.loads(sys.argv[3])
checks, warnings = resolve_checks_for_skills(skills, checks_dir)
results = run_checks(checks, app_dir)
print(json.dumps({
    "check_ids": [check.id for check in checks],
    "warnings": warnings,
    "results": [result.__dict__ for result in results],
}, sort_keys=True))
`;
      const processResult = Bun.spawnSync(
        [
          PYTHON ?? "python3",
          "-c",
          pythonScript,
          root,
          REAL_CHECKS_DIR,
          JSON.stringify(expectedSkills),
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, PYTHONPATH: REPO_ROOT },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(new TextDecoder().decode(processResult.stderr)).toBe("");
      expect(processResult.exitCode).toBe(0);
      const pythonPayload = JSON.parse(
        new TextDecoder().decode(processResult.stdout),
      ) as typeof typescriptPayload;

      expect(typescriptPayload).toEqual(pythonPayload);
    });
  },
);
