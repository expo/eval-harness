"""Importing code_checks here (rather than leaving callers to remember to)
is what populates registry._CODE_REGISTRY -- any import of a submodule of
this package (e.g. `from .uptake_checks.registry import ...`) runs this
file first, since Python always executes a package's __init__.py before a
submodule within it."""

from . import code_checks  # noqa: F401
