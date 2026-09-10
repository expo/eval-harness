/** Routing labels are separate from code checks. Unknown skills are neutral by default. */
export type Expectations = {
  required: string[];
  optional: string[];
  forbidden: string[];
  unlisted: "observe" | "forbid";
};

export function parseExpectations(value: unknown): Expectations {
  // Preserve the historical closed-set interpretation for old artifact maps.
  if (Array.isArray(value))
    return {
      required: names(value),
      optional: [],
      forbidden: [],
      unlisted: "forbid",
    };
  if (value === null || typeof value !== "object")
    throw new Error("Expected a skill list or routing expectations object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["required", "optional", "forbidden", "unlisted"].includes(key))
      throw new Error(`Unknown expectation field: ${key}`);
  }
  const required = names(raw.required ?? []);
  const optional = names(raw.optional ?? []);
  const forbidden = names(raw.forbidden ?? []);
  const all = [...required, ...optional, ...forbidden];
  if (new Set(all).size !== all.length)
    throw new Error("A skill cannot have conflicting routing expectations");
  const unlisted = raw.unlisted ?? "observe";
  if (unlisted !== "observe" && unlisted !== "forbid")
    throw new Error("unlisted must be observe or forbid");
  return { required, optional, forbidden, unlisted };
}

function names(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (name) =>
        typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name),
    )
  ) {
    throw new Error("Skill names must be a list of kebab-case identifiers");
  }
  if (new Set(value).size !== value.length)
    throw new Error("Duplicate skill expectation");
  return value as string[];
}
