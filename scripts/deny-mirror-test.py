"""grok-deny-mirror policy test — run with the Hermes venv Python.

  <hermes venv>/python.exe scripts/deny-mirror-test.py <path-to-plugin-dir>

Exercises the plugin's pure `check()` against the REAL ~/.grok/config.toml deny
list, then a mutation check with an EMPTY deny list proving every block comes
from Grok's config rather than anything hardcoded. Exit 0 = pass.
"""
import importlib.util
import os
import sys
import tempfile

plugin_dir = sys.argv[1]
spec = importlib.util.spec_from_file_location("grok_deny_mirror", os.path.join(plugin_dir, "__init__.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

passed = failed = 0


def ok(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}")


def blocked(tool, args):
    return mod.check(tool, args) is not None


H = os.path.expanduser("~").replace("\\", "/")

globs = mod._load_globs()
ok(f"real deny list loaded ({len(globs)} Edit rules)", len(globs) >= 1)
ok("~/.claude/skills is among the rules", any(".claude/skills" in g for g in globs))

# file tools
ok("write_file into ~/.claude/skills is blocked", blocked("write_file", {"path": f"{H}/.claude/skills/x/SKILL.md", "content": "x"}))
ok("write_file into D:/Program/Claude is allowed", not blocked("write_file", {"path": "D:/Program/Claude/scratch-note.txt", "content": "x"}))
ok("patch (replace mode) into ~/.codex/skills is blocked", blocked("patch", {"path": f"{H}/.codex/skills/y/SKILL.md", "old_string": "a", "new_string": "b"}))
ok("patch V4A Update File into protected is blocked", blocked("patch", {"mode": "patch", "patch": f"*** Begin Patch\n*** Update File: {H}/.claude/skills/z/SKILL.md\n@@\n-a\n+b\n*** End Patch"}))
ok("patch V4A Move to protected is blocked", blocked("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Update File: D:/Program/Claude/a.md\n*** Move to: D:/Program/Hermes/skills/a.md\n*** End Patch"}))
ok("patch V4A entirely outside protected is allowed", not blocked("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Add File: D:/Program/Claude/new.md\n+hi\n*** End Patch"}))

# spelling tricks
ok("backslash spelling is blocked", blocked("write_file", {"path": f"{H}/.claude/skills/x.md".replace("/", "\\")}))
ok("mixed case is blocked (Windows is case-insensitive)", blocked("write_file", {"path": f"{H.upper()}/.CLAUDE/Skills/x.md"}))
ok("../ traversal into protected is blocked", blocked("write_file", {"path": "D:/Program/Claude/../Hermes/skills/evil.md"}))
ok("lookalike sibling 'skills-backup' is NOT blocked", not blocked("write_file", {"path": f"{H}/.claude/skills-backup/x.md"}))

# terminal
ok("terminal read-only cat of protected is allowed", not blocked("terminal", {"command": f"cat {H}/.claude/skills/x/SKILL.md"}))
ok("terminal redirect into protected is blocked", blocked("terminal", {"command": f"echo hi > {H}\\.claude\\skills\\x.md".replace("/", "\\")}))
ok("terminal Remove-Item on protected is blocked", blocked("terminal", {"command": "Remove-Item -Recurse D:\\Program\\Hermes\\skills\\foo"}))
ok("terminal write outside protected is allowed", not blocked("terminal", {"command": "echo hi > D:/Program/Claude/out.txt"}))

# non-write tools are never touched
ok("read_file on protected is allowed", not blocked("read_file", {"path": f"{H}/.claude/skills/x/SKILL.md"}))

# block message is actionable
msg = (mod.check("write_file", {"path": f"{H}/.claude/skills/x.md"}) or {}).get("message", "")
ok("block message names the rule and config file", "Edit(" in msg and "config.toml" in msg)

# MUTATION: with an EMPTY deny list the same protected write must be ALLOWED,
# proving the blocks above come from Grok's config and not a hardcoded path.
with tempfile.TemporaryDirectory() as td:
    empty = os.path.join(td, "config.toml")
    with open(empty, "w", encoding="utf-8") as fh:
        fh.write("[permission]\ndeny = []\n")
    mod.GROK_CONFIG = empty
    mod._cache.update(mtime=None, globs=[])
    ok("MUTATION: empty deny list allows the protected write (test has teeth)",
       not blocked("write_file", {"path": f"{H}/.claude/skills/x/SKILL.md"}))

print(f"\n  RESULT: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
