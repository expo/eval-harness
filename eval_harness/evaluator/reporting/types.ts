export type StageStatus = "passed" | "warning" | "failed" | "not_run";

export type BuildHealthStage = {
  id: string;
  label: string;
  status: StageStatus;
  detail: string | null;
  log: string | null;
};

export type ReportInputs = {
  authoredArtifact: string;
  skillArtifact: string | null;
  iosArtifact: string | null;
  outDir: string;
};

export type ConsolidatedSummary = {
  schema_version: 1;
  status: "complete" | "partial" | "failed";
  run: Record<string, unknown>;
  scores: {
    ios_macro_pct: number | null;
    skill_trigger_recall: number | null;
    skill_uptake_rate: number | null;
  };
  build_health: BuildHealthStage[];
  skills: unknown[];
  ios: { test_plans: unknown[] };
  usage: {
    author: Record<string, number | null>;
    evaluator: Record<string, number | null>;
  };
  warnings: string[];
  artifacts: Record<string, string | null>;
};
