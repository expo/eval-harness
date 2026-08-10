"""
Agent-device-driven evaluator — Claude Agent SDK with AgentDeviceBridge underneath.

Mirrors `maestro_evaluator.py` exactly except:
  - Instantiates `AgentDeviceBridge` instead of `MaestroBridge`.
  - Imports tools from `agent_device_tools` instead of `maestro_tools`.
  - Class name `AgentDeviceEvaluator`.

Everything else — scoring, prompt, hooks, tracing, turn aggregation, step
transition protocol — is identical to the Maestro path and reuses the same
shared modules (`scoring`, `tracer`, `prompt_agent`, `agent_hooks`,
`tool_state`, `turn_aggregator`).
"""

import asyncio
import os
import sys
import time
from pathlib import Path

# When run with stdout piped (e.g. `… | tee log`), Python switches to block
# buffering and verbose output stalls. Force line buffering so every newline
# flushes, regardless of how the user invokes us.
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

from dotenv import load_dotenv

load_dotenv()

# The claude-agent-sdk Vertex client needs ANTHROPIC_VERTEX_PROJECT_ID;
# GOOGLE_CLOUD_PROJECT does not propagate to its Vertex SDK init.
if "GOOGLE_CLOUD_PROJECT" in os.environ and "ANTHROPIC_VERTEX_PROJECT_ID" not in os.environ:
    os.environ["ANTHROPIC_VERTEX_PROJECT_ID"] = os.environ["GOOGLE_CLOUD_PROJECT"]

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    UserMessage,
)

from ..core.test_plan_parser import parse_test_plan

from .bridge import AgentDeviceBridge
from ..core.tracer import Tracer
from ..core.tool_state import StepState, ToolContext
from .tools import build_tools
from ..core.agent_hooks import build_hooks
from ..prompts.prompt_agent import build_system_prompt
from ..core.turn_aggregator import TurnAggregator, UsageAccumulator

from ..core.scoring import (
    AssertionResult,
    SoftAssertionResult,
    StepResult,
    TestPlanResult,
    score_step,
)


# ----- The evaluator -----

class AgentDeviceEvaluator:
    """
    Drives a test plan through Claude Sonnet via Vertex AI using the Claude Agent
    SDK with AgentDeviceBridge as the device execution layer. Same public surface
    as MaestroEvaluator (`evaluate_test_plan` → TestPlanResult).
    """

    def __init__(
        self,
        platform: str = "ios",
        max_iterations: int = 50,
        timeout: int = 60,
        verbose: bool = False,
        prd_path: Path | None = None,
        hybrid_restart: bool = False,
        seed_iterations: int = 100,
    ):
        self.platform = platform
        self.max_iterations = max_iterations
        self.seed_iterations = seed_iterations
        self.verbose = verbose
        self.prd_text = prd_path.read_text() if prd_path else ""
        self.hybrid_restart = hybrid_restart
        self.bridge = AgentDeviceBridge(
            platform=platform, timeout=timeout, verbose=verbose,
        )

    def evaluate_test_plan(self, test_plan_path: Path) -> TestPlanResult:
        return asyncio.run(self._evaluate_test_plan_async(test_plan_path))

    async def _evaluate_test_plan_async(self, test_plan_path: Path) -> TestPlanResult:
        tracer = Tracer(plan_stem=test_plan_path.stem, root=_trace_root_for(test_plan_path))
        os.environ["EVAL_SCREENSHOT_DIR"] = str(tracer.root / "screenshots")
        tracer.capture_console()
        try:
            return await self._evaluate_test_plan_inner_async(test_plan_path, tracer)
        finally:
            tracer.close()

    async def _evaluate_test_plan_inner_async(
        self,
        test_plan_path: Path,
        tracer: Tracer,
    ) -> TestPlanResult:
        plan = parse_test_plan(test_plan_path)
        result = TestPlanResult(score=0, full_points=plan["full_points"])

        tracer.log(
            "plan_start",
            plan=test_plan_path.name,
            platform=self.platform,
            driver="agent-device",
            full_points=plan["full_points"],
            num_steps=len(plan["steps"]),
        )

        print(f"\n{'━'*60}")
        print(f"  TEST PLAN: {test_plan_path.name}  (agent-device driver)")
        print(f"  Steps: {len(plan['steps'])}  |  Full points: {plan['full_points']}")
        print(f"  Trace: {tracer.root}")
        print(f"{'━'*60}")

        restart_label = "maestro hybrid" if self.hybrid_restart else "agent-device native"
        print(f"\n  Resetting app state ({restart_label})...\n")
        reset = (
            self.bridge.restart_app_hybrid(clear_state=True)
            if self.hybrid_restart
            else self.bridge.restart_app(clear_state=True)
        )
        # If Maestro-hybrid restart failed (e.g. 90s timeout, JVM hang, transient
        # CLI issue), fall back to the native agent-device restart before aborting
        # the cell. The two paths have different failure modes — Maestro fails on
        # its YAML runner / JVM infra, native fails on Bottom Sheet backdrop
        # dismissal — so the combined success rate is much higher than either
        # alone. Observed ~5% Maestro-restart flake rate in the 5×5×3 matrix;
        # this should make those into N/A noise instead of structural zeros.
        if not reset.success and self.hybrid_restart:
            fallback_err = reset.error or (reset.output or "")[:120]
            print(f"  ⚠️  maestro restart failed: {fallback_err}")
            print(f"  → falling back to agent-device native restart…")
            tracer.log("restart_fallback", primary_err=fallback_err)
            reset = self.bridge.restart_app(clear_state=True)
        if not reset.success:
            err = reset.error or reset.output or "(no error detail)"
            print(f"\n  ❌ restart_app failed: {err}")
            tracer.log("plan_aborted", reason="restart_app_failed", error=err)
            result.status = "evaluator_error"
            result.error_stage = "restart"
            result.error_reason = err
            return result

        # Build the SDK options. Tools are an MCP server; hooks track per-tool durations.
        ctx = ToolContext(self.bridge)
        mcp_server, tool_names = build_tools(ctx)
        allowed_tools = [f"mcp__adaptive__{name}" for name in tool_names]
        tool_timing: dict[str, dict] = {}
        # max_turns is enforced per query/response cycle by the SDK. Use the larger
        # of seed_iterations and max_iterations so neither phase is artificially
        # constrained; the per-phase prompt explicitly states the actual budget
        # for that phase.
        options = ClaudeAgentOptions(
            system_prompt=build_system_prompt(self.platform),
            mcp_servers={"adaptive": mcp_server},
            allowed_tools=allowed_tools,
            disallowed_tools=_BUILTIN_TOOLS_TO_BLOCK,
            permission_mode="bypassPermissions",
            setting_sources=[],
            hooks=build_hooks(tool_timing),
            include_hook_events=False,
            max_turns=max(self.seed_iterations, self.max_iterations),
            max_thinking_tokens=1024,
        )

        agg_usage = UsageAccumulator()

        async with ClaudeSDKClient(options=options) as client:
            # ----- Pre-flight seeding phase -----
            # Runs the <seeding_and_precondition> instructions with its own turn
            # budget BEFORE the formal steps. Assertions recorded during seeding
            # are not appended to result.steps (not scored). The PRD is injected
            # here once for the whole conversation; subsequent step prompts can
            # rely on the SDK session retaining that context.
            seeding_clean = (plan.get("seeding") or "").strip()
            seeding_is_actionable = bool(seeding_clean) and seeding_clean.upper() != "N/A"
            prd_already_injected = False
            if seeding_is_actionable or self.prd_text.strip():
                print(f"\n{'='*60}")
                print(f"  Seed phase  (budget: {self.seed_iterations} turns)")
                print(f"{'='*60}")
                tracer.log("seed_start", budget=self.seed_iterations)

                seed_step_stub = {"name": "__seed__", "description": "", "points": 0}
                state = ctx.reset_state(seed_step_stub)
                turn_agg = TurnAggregator(
                    step_number=0,
                    tracer=tracer,
                    tool_timing=tool_timing,
                    state=state,
                    verbose=self.verbose,
                    plan_start_time=tracer.start_time,
                )

                await client.query(_seed_prompt(seeding_clean, self.seed_iterations, self.prd_text))
                await self._receive_phase_response(client, state, turn_agg, agg_usage)

                turn_agg.flush(reason="seed_end")
                tracer.log(
                    "seed_complete",
                    turns_used=state.turns_used,
                    completed_by_llm=state.completed,
                    n_assertions=len(state.assertions),
                    n_soft_assertions=len(state.soft_assertions),
                )
                prd_already_injected = bool(self.prd_text.strip())

                if state.aborted:
                    result.status = "evaluator_error"
                    result.error_stage = "seed"
                    result.error_reason = (
                        f"{state.abort_category}: {state.abort_reason}"
                        if state.abort_category
                        else state.abort_reason
                    )
                    tracer.log(
                        "plan_aborted",
                        reason="agent_aborted_seed",
                        category=state.abort_category,
                        error=state.abort_reason,
                    )
                    return result

                if not state.completed:
                    result.status = "evaluator_error"
                    result.error_stage = "seed"
                    result.error_reason = "seed response ended without complete_step or abort_step"
                    tracer.log(
                        "plan_aborted",
                        reason="seed_ended_without_terminal_tool",
                        error=result.error_reason,
                    )
                    return result

                # N/A short-circuit: if the seed-phase complete_step summary
                # starts with "N/A" (the escape clause that generic primitive
                # plans embed for apps where the primitive doesn't apply), skip
                # the formal scored steps entirely and report the test plan as
                # not_applicable. Without this short-circuit the formal steps
                # would run, "verify" features that don't exist, and fail
                # fatally — polluting the macro % with structural zeros for
                # genuinely-not-applicable cells.
                seed_summary = (state.complete_summary or "").strip()
                if seed_summary.upper().startswith("SETUP BLOCKED:"):
                    result.status = "evaluator_error"
                    result.error_stage = "seed"
                    result.error_reason = seed_summary
                    tracer.log(
                        "plan_aborted",
                        reason="legacy_setup_blocked",
                        error=seed_summary,
                    )
                    return result
                if state.completed and seed_summary.upper().startswith("N/A"):
                    print(f"\n{'='*60}")
                    print(f"  N/A short-circuit  —  {seed_summary[:120]}")
                    print(f"  Skipping {len(plan['steps'])} formal step(s); test reported as not_applicable.")
                    print(f"{'='*60}")
                    tracer.log(
                        "test_plan_not_applicable",
                        na_reason=seed_summary,
                        steps_skipped=len(plan["steps"]),
                    )
                    result.not_applicable = True
                    result.status = "not_applicable"
                    result.na_reason = seed_summary
                    return result

            # ----- Formal steps loop (scored) -----
            for i, step in enumerate(plan["steps"], 1):
                print(f"\n{'='*60}")
                print(f"  Step {i}/{len(plan['steps'])}: {step['name']}")
                print(f"  Points: {step['points']}")
                print(f"{'='*60}")
                tracer.log("step_start", step_number=i, name=step["name"], points=step["points"])

                state = ctx.reset_state(step)
                turn_agg = TurnAggregator(
                    step_number=i,
                    tracer=tracer,
                    tool_timing=tool_timing,
                    state=state,
                    verbose=self.verbose,
                    plan_start_time=tracer.start_time,
                )

                # Seeding + PRD are injected during the pre-flight seed phase
                # (see above) and persist in the SDK session's context, so step
                # prompts no longer re-inject them.
                await client.query(_step_prompt(i, len(plan["steps"]), step, self.max_iterations))
                await self._receive_phase_response(client, state, turn_agg, agg_usage)

                turn_agg.flush(reason="step_end")

                if state.aborted or not state.completed:
                    result.status = "evaluator_error"
                    result.error_stage = f"step_{i}"
                    if state.aborted:
                        result.error_reason = (
                            f"{state.abort_category}: {state.abort_reason}"
                            if state.abort_category
                            else state.abort_reason
                        )
                        abort_reason = "agent_aborted_step"
                    else:
                        result.error_reason = (
                            "step response ended without complete_step or abort_step"
                        )
                        abort_reason = "step_ended_without_terminal_tool"
                    tracer.log(
                        "plan_aborted",
                        reason=abort_reason,
                        step_number=i,
                        category=state.abort_category,
                        error=result.error_reason,
                    )
                    return result

                step_result = score_step(step, state.assertions, state.soft_assertions, state.completed, state.turns_used)
                result.steps.append(step_result)
                result.score += step_result.earned_points

                status = "✅ PASSED" if step_result.passed else "❌ FAILED"
                print(f"\n  {'='*50}")
                print(f"  {status}  —  {step_result.earned_points}/{step_result.max_points} pts  ({step_result.iterations_used} turns)")
                print(f"  {'='*50}")
                tracer.log(
                    "step_complete",
                    step_number=i,
                    name=step["name"],
                    earned=step_result.earned_points,
                    max=step_result.max_points,
                    passed=step_result.passed,
                    turns_used=step_result.iterations_used,
                    completed_by_llm=step_result.completed_by_llm,
                    fatal_failed=state.fatal_failed,
                    n_assertions=len(state.assertions),
                    n_soft_assertions=len(state.soft_assertions),
                    step_usage=turn_agg.step_usage.snapshot(),
                    sdk_result=turn_agg.sdk_result,
                )

        print(f"\n{'━'*60}")
        print(f"  PLAN SCORE: {result.score}/{result.full_points}")
        print(f"{'━'*60}")
        result.status = "completed"

        tracer.write_summary({
            "plan": test_plan_path.name,
            "platform": self.platform,
            "driver": "agent-device",
            "score": result.score,
            "full_points": result.full_points,
            "total_usage": agg_usage.snapshot(),
            "steps": [
                {
                    "name": s.name,
                    "earned": s.earned_points,
                    "max": s.max_points,
                    "passed": s.passed,
                    "turns_used": s.iterations_used,
                    "completed_by_llm": s.completed_by_llm,
                    "n_assertions": len(s.assertions),
                    "n_soft_assertions": len(s.soft_assertions),
                }
                for s in result.steps
            ],
        })
        return result

    # ----- Message processing -----

    async def _receive_phase_response(
        self,
        client,
        state: StepState,
        turn_agg: TurnAggregator,
        agg_usage: UsageAccumulator,
    ) -> None:
        """Process one SDK response and stop model work at a terminal tool call.

        MCP tools mutate ``state`` before their tool-result UserMessage reaches
        this loop. Once complete_step or abort_step has done so, interrupt the
        streaming response exactly once. Drain messages through ResultMessage so
        the SDK is ready for the next query, but ignore post-terminal model work.
        """
        interrupted = False
        async for message in client.receive_response():
            if interrupted and not isinstance(message, ResultMessage):
                continue

            self._process_message(message, turn_agg, agg_usage)
            if isinstance(message, ResultMessage):
                break

            if (state.completed or state.aborted) and not interrupted:
                await client.interrupt()
                interrupted = True

    def _process_message(
        self,
        message,
        turn_agg: TurnAggregator,
        agg_usage: UsageAccumulator,
    ) -> None:
        if isinstance(message, AssistantMessage):
            turn_agg.on_assistant(message)
            agg_usage.add(message.usage or {}, None)
        elif isinstance(message, UserMessage):
            turn_agg.on_user(message)
        elif isinstance(message, ResultMessage):
            turn_agg.on_result(message)
            agg_usage.add(message.usage or {}, message.total_cost_usd)


# ----- Helpers -----


def _trace_root_for(test_plan_path: Path) -> Path:
    """
    Derive a per-app trace root from the test plan path.
    `prds/<app>/tests/...` → `traces/<app>/`; anything else → `traces/`.
    """
    parts = test_plan_path.parts
    if "prds" in parts:
        i = parts.index("prds")
        if i + 1 < len(parts):
            return Path("traces") / parts[i + 1]
    return Path("traces")


_BUILTIN_TOOLS_TO_BLOCK = [
    "Glob", "Grep", "Read", "Write", "Edit", "NotebookEdit",
    "Bash", "BashOutput", "KillBash", "KillShell",
    "WebFetch", "WebSearch",
    "TodoWrite", "Task",
]


def _seed_prompt(seeding: str, budget: int, prd: str = "") -> str:
    """Prompt for the pre-flight seed phase.

    Includes the PRD (once, for the whole conversation), the seeding instructions,
    and an explicit directive that this phase is SETUP (no scoring, no assertions).
    """
    prd_block = ""
    prd_clean = (prd or "").strip()
    if prd_clean:
        prd_block = (
            "## App PRD\n"
            "The full product requirements document for the app under test is provided "
            "below. Use it as the authoritative source for app-specific context: screen "
            "shapes, fixtures (e.g. credentials, sample values), expected behaviors, "
            "and any constraints the app should respect. The test plan that follows may "
            "be app-agnostic and rely on you to map abstract verifications onto this "
            "specific app's UI by reading the PRD.\n\n"
            f"{prd_clean}\n\n"
            "---\n\n"
        )

    seeding_clean = (seeding or "").strip()
    seeding_block = ""
    if seeding_clean and seeding_clean.upper() != "N/A":
        seeding_block = (
            "## Setup Instructions\n"
            f"{seeding_clean}\n\n"
        )
    else:
        seeding_block = (
            "## Setup Instructions\n"
            "No specific setup is required for this test plan. After reading the PRD "
            "above (if provided), call complete_step with a brief summary acknowledging "
            "you are ready, and the first formal test step will follow.\n\n"
        )

    return (
        f"{prd_block}"
        f"# Pre-test Setup Phase\n"
        "This is the setup phase that precedes the formal test. Perform the setup "
        "actions described below to get the app into the required state for the formal "
        "test. This phase is NOT scored.\n\n"
        "Important:\n"
        "- DO NOT record any assertions during this phase — neither hard "
        "(`assert_visible` / `assert_not_visible`) nor soft (`record_soft_assertion`). "
        "Assertions are reserved for the formal test steps that follow.\n"
        "- Be efficient: use minimum-viable values when filling forms (shortest valid "
        "description, simplest valid email, etc.); prefer using EXISTING items in any "
        "list rather than creating new ones when the setup instructions allow.\n"
        "- Seed MINIMALLY for the primitive at hand. Set up only the state required to "
        "exercise THIS primitive in the formal steps below. Do NOT pursue thoroughness "
        "in setup — placeholder values for non-essential fields are fine. If the app "
        "has multiple user roles, account types, or actor categories (e.g. customer vs. "
        "vendor, free vs. paid, normal vs. admin), set up ONLY the role(s) this "
        "primitive actually requires to be triggered — not all of them. When in doubt, "
        "less setup is better than more; the formal steps that follow will tell you if "
        "more state was needed.\n"
        "- When the setup is complete, call `complete_step` with a brief summary of "
        "what you did. The first formal test step will then follow.\n\n"
        "- If setup becomes impossible because a required text field cannot be filled "
        "and no alternate non-text route can prepare the requested state, stop setup "
        "instead of retrying indefinitely. Call `complete_step` with a summary "
        "starting `SETUP BLOCKED:` and cite the field/tool error. The formal steps "
        "will then score the observable app state.\n\n"
        f"{seeding_block}"
        f"Budget: up to {budget} tool-emitting turns for the setup phase."
    )


def _step_prompt(step_number: int, total_steps: int, step: dict, budget: int) -> str:
    """Prompt for a formal (scored) test step. Seeding + PRD are injected once
    during the pre-flight seed phase; the SDK session retains them in context,
    so step prompts no longer carry that overhead."""
    return (
        f"# Step {step_number} of {total_steps}: {step['name']}\n"
        f"Points: {step['points']}\n\n"
        f"{step['description']}\n\n"
        f"Work through the actions and verifications above. "
        f"Use `capture_screen` to see the current state, run any actions you need, "
        f"and record hard / soft assertions for each verification. "
        f"When all verifications listed are recorded, call `complete_step`. "
        f"Budget: up to {budget} tool-emitting turns for this step."
    )
