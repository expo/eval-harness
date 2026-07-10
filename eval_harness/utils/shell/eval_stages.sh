#!/usr/bin/env bash
# Aggregates the shell helpers used by workflow entrypoints.
#
# Entrypoint scripts source this one file. The implementation is split by
# responsibility so agent setup, iOS runtime, evaluator execution, telemetry,
# and logging helpers can evolve independently.

[ -n "${_EVAL_STAGES_SOURCED:-}" ] && return 0
_EVAL_STAGES_SOURCED=1
_EVAL_STAGES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=eval_harness/utils/shell/primitives.sh
source "$_EVAL_STAGES_DIR/primitives.sh"
# shellcheck source=eval_harness/utils/shell/install.sh
source "$_EVAL_STAGES_DIR/install.sh"
# shellcheck source=eval_harness/utils/shell/ios.sh
source "$_EVAL_STAGES_DIR/ios.sh"
# shellcheck source=eval_harness/utils/shell/app_runtime.sh
source "$_EVAL_STAGES_DIR/app_runtime.sh"
# shellcheck source=eval_harness/utils/shell/evaluator.sh
source "$_EVAL_STAGES_DIR/evaluator.sh"
# shellcheck source=eval_harness/utils/shell/agents.sh
source "$_EVAL_STAGES_DIR/agents.sh"
# shellcheck source=eval_harness/utils/shell/telemetry.sh
source "$_EVAL_STAGES_DIR/telemetry.sh"
