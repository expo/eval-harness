import { AppTree } from "../uptake_checks/registry.ts";
import { checkSourceSyntax } from "./node_parser.ts";

export type SyntaxCheckResult = {
  total_files: number;
  checked_files: number;
  skipped_unavailable: number;
  failed_files: Array<{ file: string; message: string }>;
  ok: boolean | null;
};

export async function checkSyntax(appDir: string): Promise<SyntaxCheckResult> {
  // AppTree performs directory discovery and source reads concurrently.
  // Promise.all preserves result order here, but Babel parsing remains
  // synchronous CPU work unless it is later moved into worker threads.
  const appTree = await AppTree.load(appDir);
  const checkedFiles = await Promise.all(
    [...appTree.files].map(async ([relativePath, source]) => ({
      relativePath,
      facts: checkSourceSyntax(source),
    })),
  );
  const failedFiles = checkedFiles.flatMap(({ relativePath, facts }) =>
    "error" in facts
      ? [{ file: relativePath, message: facts.message }]
      : [],
  );
  const total = appTree.files.size;
  return {
    total_files: total,
    checked_files: total,
    skipped_unavailable: 0,
    failed_files: failedFiles,
    ok: total > 0 ? failedFiles.length === 0 : null,
  };
}
