// Executes authored dynamic config in this bounded child, without CI secrets.
import { getConfig } from "@expo/config";
import { deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./outcomes.ts";

const workspace = process.argv[2]!;
const original = JSON.parse(
  readFileSync(join(process.argv[3]!, "app.json"), "utf8"),
).expo;
const rows: Check[] = [];
for (const [id, value] of [
  ["expo-config-default", undefined],
  ["expo-config-empty", ""],
  ["expo-config-environment", "https://preview.fixture.invalid/v2"],
] as const) {
  try {
    if (value === undefined) delete process.env.EXPO_PUBLIC_API_URL;
    else process.env.EXPO_PUBLIC_API_URL = value;
    const { exp } = getConfig(workspace, { skipSDKVersionRequirement: true });
    const expected = {
      ...original,
      ios: { ...original.ios, supportsTablet: false },
      extra: { ...original.extra, apiUrl: value || "https://api.example.test" },
    };
    // Expo adds internal/default fields. Compare every user-owned config key.
    for (const key of Object.keys(expected))
      deepStrictEqual(
        (exp as unknown as Record<string, unknown>)[key],
        expected[key],
        key,
      );
    rows.push({
      id,
      status: "passed",
      evidence: `Expo resolved the expected config with API environment ${JSON.stringify(value) ?? "unset"}; existing settings preserved.`,
    });
  } catch (error) {
    rows.push({ id, status: "failed", evidence: String(error) });
  }
}
console.log(JSON.stringify(rows));
