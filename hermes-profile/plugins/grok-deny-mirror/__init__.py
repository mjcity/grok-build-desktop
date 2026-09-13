"""grok-deny-mirror — enforce Grok Build's deny list inside a Hermes profile.

Grok Build runs grok.exe with --always-approve, but ~/.grok/config.toml carries a
[permission] deny list of Edit(<glob>) rules that protect other agents' skill
directories. The Frozen Local provider runs the real Hermes agent instead of
grok.exe, and Hermes' own write-deny list is hardcoded (credentials only), so
without this plugin a local session would be a back door around those rules.

Single source of truth: the deny list is read from ~/.grok/config.toml (re-read
when its mtime changes), never copied. A rule added for Grok applies here too.

Vetoes via Hermes' documented pre_tool_call contract:
    return {"action": "block", "message": "..."}   # message becomes the tool result
"""
from __future__ import annotations

import fnmatch
import os
import re
import threading

try:  # Python 3.11+
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

GROK_CONFIG = os.environ.get(
    "GROK_DENY_MIRROR_CONFIG", os.path.join(os.path.expanduser("~"), ".grok", "config.toml")
)

_lock = threading.Lock()
_cache = {"mtime": None, "globs": []}

# Terminal verbs that mutate the filesystem. Read-only commands (cat/ls/type/
# Get-Content) that merely mention a protected path stay allowed, matching
# Grok's rule, which is scoped to Edit.
_WRITE_VERB = re.compile(
    r"(?:^|[\s;&|(])(?:rm|rmdir|del|erase|mv|move|cp|copy|xcopy|robocopy|tee|touch|mkdir|md|"
    r"truncate|install|ln|chmod|chown|sed\s+-i|perl\s+-pi|git\s+(?:apply|checkout|restore|rm|mv|reset|clean)|"
    r"set-content|add-content|out-file|remove-item|move-item|copy-item|new-item|rename-item|"
    r"clear-content|set-itemproperty)\b"
    r"|>>?",
    re.IGNORECASE,
)


def _norm(p: str) -> str:
    """Case-insensitive, forward-slash, no trailing slash — Windows semantics."""
    p = os.path.expandvars(os.path.expanduser(str(p).strip().strip('"').strip("'")))
    if not os.path.isabs(p):
        base = os.environ.get("TERMINAL_CWD") or os.getcwd()
        p = os.path.join(base, p)
    p = os.path.normpath(p).replace("\\", "/")
    return p.rstrip("/").lower()


def _load_globs() -> list[str]:
    """Edit(<glob>) entries from Grok's [permission] deny list, mtime-cached."""
    try:
        mtime = os.path.getmtime(GROK_CONFIG)
    except OSError:
        return []
    with _lock:
        if _cache["mtime"] == mtime:
            return _cache["globs"]
        globs: list[str] = []
        try:
            if tomllib is not None:
                with open(GROK_CONFIG, "rb") as fh:
                    deny = (tomllib.load(fh).get("permission") or {}).get("deny") or []
            else:  # crude fallback — only reached on Python < 3.11
                deny = re.findall(r'"(Edit\([^"]+\))"', open(GROK_CONFIG, encoding="utf-8").read())
            for rule in deny:
                m = re.fullmatch(r"\s*Edit\((.+)\)\s*", str(rule))
                if m:
                    globs.append(m.group(1).strip())
        except Exception:
            globs = _cache["globs"]  # keep the last good list rather than fail open
        _cache.update(mtime=mtime, globs=globs)
        return globs


def _match(path: str, globs: list[str]) -> str | None:
    """Return the glob that denies *path*, or None."""
    target = _norm(path)
    for g in globs:
        ng = g.replace("\\", "/").lower()
        if ng.endswith("/**"):
            root = _norm(ng[:-3])
            if target == root or target.startswith(root + "/"):
                return g
        elif fnmatch.fnmatch(target, _norm(ng)):
            return g
    return None


def _roots(globs: list[str]) -> list[tuple[str, str]]:
    out = []
    for g in globs:
        ng = g.replace("\\", "/")
        root = ng[:-3] if ng.endswith("/**") else ng
        out.append((g, _norm(root)))
    return out


_V4A_PATH = re.compile(
    r"^\*\*\*\s+(?:(?:Update|Add|Delete)\s+File|Move\s+to):\s*(.+?)\s*$", re.MULTILINE
)


def _paths_in_v4a(patch: str) -> list[str]:
    """Every file a V4A patch touches: Update/Add/Delete File targets and Move-to destinations."""
    return _V4A_PATH.findall(patch or "")


def _block(path: str, glob: str) -> dict:
    return {
        "action": "block",
        "message": (
            f"Blocked by Grok Build policy: '{path}' matches deny rule Edit({glob}) "
            f"in ~/.grok/config.toml. This location is protected for every agent; "
            f"do not retry with another tool or path spelling."
        ),
    }


def check(tool_name: str, args: dict | None) -> dict | None:
    """Pure policy decision — exposed for tests. Returns a block directive or None."""
    args = args if isinstance(args, dict) else {}
    globs = _load_globs()
    if not globs:
        return None

    if tool_name in ("write_file", "patch"):
        candidates = []
        if args.get("path"):
            candidates.append(args["path"])
        if tool_name == "patch" and args.get("patch"):
            candidates.extend(_paths_in_v4a(args["patch"]))
        for p in candidates:
            g = _match(p, globs)
            if g:
                return _block(p, g)
        return None

    if tool_name == "terminal":
        cmd = str(args.get("command") or "")
        if not _WRITE_VERB.search(cmd):
            return None
        flat = cmd.replace("\\", "/").lower()
        for g, root in _roots(globs):
            if root and root in flat:
                return _block(root, g)
        return None

    return None


def _on_pre_tool_call(tool_name: str = "", args: dict | None = None, **_kw):
    return check(tool_name, args)


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
