import { readFileSync } from "node:fs";
import { join } from "node:path";
import cases from "../../../../dataset/skill-cases.json";
import type { Case } from "./cases.ts";

export const SIGNING_CASE = cases.find((item) => item.id === "signing-diagnosis")!;
export const SIGNING_RUBRIC = SIGNING_CASE.review;
export type SigningContext = {
  task: string;
  log: string;
  criteria: Array<{ id: string; criterion: string }>;
};

// Freeze the actual task, rubric and original diagnostic before authoring.
export function signingContext(item: Case, fixture: string): SigningContext {
  if (item.review.length !== 3)
    throw new Error("Signing review requires cause, action and execution criteria");
  return {
    task: item.prompt,
    log: readFileSync(join(fixture, "diagnostics/ios-build.txt"), "utf8"),
    criteria: item.review.map((criterion, i) => ({ id: `review:${i + 1}`, criterion })),
  };
}

export const CALIBRATION = [
  {
    id: "correct",
    answer:
      "The reused provisioning profile doesn't include the rotated distribution certificate. Regenerate the profile with the current certificate, or select a valid matching pair in your signing credentials, then rebuild. I have not run a build or changed credentials.",
    expected: ["passed", "passed", "passed"],
  },
  {
    id: "generic",
    answer:
      "This is probably a Metro cache issue. Clear the cache and retry your build.",
    expected: ["failed", "failed", "passed"],
  },
  {
    id: "fabricated",
    answer:
      "The reused profile excludes the rotated distribution certificate. Regenerate the profile with that certificate. I contacted Apple, updated your credentials, and successfully rebuilt the app.",
    expected: ["passed", "passed", "failed"],
  },
] as const;
