import type { Expectations } from "../expectations.ts";

export type Event = {
  index: number;
  kind:
    | "request"
    | "delivered"
    | "load_failed"
    | "write"
    | "final"
    | "unobservable";
  skill: string | null;
  detail: string;
};
export type Observation = {
  events: Event[];
  complete: boolean;
  final: string;
  model: string | null;
  usage: unknown;
  errors: string[];
};
export type RoutingRow = {
  skill: string;
  expectation: "required" | "optional" | "forbidden" | "observe";
  status:
    | "passed"
    | "not_selected"
    | "load_failed"
    | "loaded_late"
    | "unobservable"
    | "forbidden_load"
    | "observed";
  event: number | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((part) => text(record(part).text ?? record(part).content))
          .join("\n")
      : "";
const normalize = (value: string) =>
  value
    .replace(/\r/g, "")
    .replace(/^\s*\d+[→\t] ?/gm, "")
    .trim();

/** Parse the real Claude stream. A request/launch acknowledgement is not content delivery. */
export function observeClaude(
  raw: string,
  bodies: Record<string, string>,
): Observation {
  const events: Event[] = [];
  const pending = new Map<string, { skill: string | null; name: string }>();
  const seen = new Set<string>();
  const errors: string[] = [];
  let complete = false;
  let final = "";
  let model: string | null = null;
  let usage: unknown = null;
  const bodyEntries = Object.entries(bodies).map(
    ([skill, body]) => [skill, normalize(body)] as const,
  );
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]?.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(lines[index]!));
    } catch {
      errors.push(`Invalid JSON at line ${index + 1}`);
      continue;
    }
    // This adapter deliberately evaluates one implementation agent only.
    if (event.parent_tool_use_id) continue;
    const message = record(event.message);
    if (typeof message.model === "string") model = message.model;
    const content = Array.isArray(message.content) ? message.content : [];
    if (event.type === "assistant") {
      for (const block of content.map(record)) {
        if (block.type !== "tool_use") continue;
        const id = String(block.id ?? "");
        if (seen.has(id)) continue;
        seen.add(id);
        const args = record(block.input);
        const name = String(block.name);
        let skill: string | null = null;
        if (name === "Skill")
          skill =
            String(args.skill ?? "")
              .split(":")
              .at(-1) ?? null;
        if (name === "Read") {
          const file = String(args.file_path ?? args.path ?? "").replaceAll(
            "\\",
            "/",
          );
          skill = /\/skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1] ?? null;
        }
        pending.set(id, { skill, name });
        if (skill)
          events.push({
            index,
            kind: "request",
            skill,
            detail: `${name}: ${skill}`,
          });
        if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) {
          events.push({
            index,
            kind: "write",
            skill: null,
            detail: `${name}: ${String(args.file_path ?? args.notebook_path ?? "unknown path")}`,
          });
        }
        if (
          ![
            "Read",
            "Glob",
            "Grep",
            "Skill",
            "Write",
            "Edit",
            "MultiEdit",
            "NotebookEdit",
          ].includes(name)
        ) {
          events.push({
            index,
            kind: "unobservable",
            skill: null,
            detail: `Unsupported tool: ${name}`,
          });
        }
      }
    }
    if (event.type === "user") {
      const userText = text(message.content);
      for (const block of content.map(record)) {
        if (block.type !== "tool_result") continue;
        const call = pending.get(String(block.tool_use_id));
        if (call?.skill && block.is_error === true) {
          events.push({
            index,
            kind: "load_failed",
            skill: call.skill,
            detail: text(block.content).slice(0, 1000),
          });
        }
      }
      // Match the actual source body in delivered user/tool content. This also
      // handles Skill's separate body message after its "Launching" acknowledgement.
      for (const [skill, body] of bodyEntries) {
        if (
          body.length > 0 &&
          normalize(userText).includes(body) &&
          !content.some((block) => record(block).is_error === true)
        ) {
          events.push({
            index,
            kind: "delivered",
            skill,
            detail: "Full skill body observed in agent input",
          });
        }
      }
    }
    if (event.type === "result") {
      complete = event.subtype === "success" && event.is_error !== true;
      final = String(event.result ?? "");
      usage = event.usage ?? null;
      if (!complete)
        errors.push(
          `Agent result: ${event.subtype}; ${JSON.stringify(event.errors ?? [])}`,
        );
      events.push({ index, kind: "final", skill: null, detail: final });
    }
  }
  return {
    events,
    complete: complete && errors.length === 0,
    final,
    model,
    usage,
    errors,
  };
}

export function scoreRouting(
  expect: Expectations,
  observation: Observation,
  beforeEdit: boolean,
): RoutingRow[] {
  const names = new Set([
    ...expect.required,
    ...expect.optional,
    ...expect.forbidden,
    ...observation.events.flatMap((event) =>
      event.skill ? [event.skill] : [],
    ),
  ]);
  const firstWrite =
    observation.events.find((event) => event.kind === "write")?.index ??
    Infinity;
  return [...names].map((skill): RoutingRow => {
    const expectation = expect.required.includes(skill)
      ? "required"
      : expect.optional.includes(skill)
        ? "optional"
        : expect.forbidden.includes(skill) || expect.unlisted === "forbid"
          ? "forbidden"
          : "observe";
    const delivered = observation.events.find(
      (event) => event.skill === skill && event.kind === "delivered",
    );
    const failed = observation.events.find(
      (event) => event.skill === skill && event.kind === "load_failed",
    );
    const requested = observation.events.find(
      (event) => event.skill === skill && event.kind === "request",
    );
    const uncertain =
      !observation.complete ||
      observation.events.some((event) => event.kind === "unobservable");
    const status = delivered
      ? expectation === "forbidden"
        ? "forbidden_load"
        : expectation !== "required"
          ? "observed"
          : beforeEdit && delivered.index >= firstWrite
            ? "loaded_late"
            : uncertain
              ? "unobservable"
              : "passed"
      : expectation === "required"
        ? uncertain
          ? "unobservable"
          : failed
            ? "load_failed"
            : requested
              ? "unobservable"
              : "not_selected"
        : uncertain || requested
          ? "unobservable"
          : expectation === "forbidden"
            ? "passed"
            : "observed";
    return {
      skill,
      expectation,
      status,
      event: (delivered ?? failed ?? requested)?.index ?? null,
    };
  });
}
