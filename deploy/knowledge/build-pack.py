#!/usr/bin/env python3
"""Build the agent's read-only knowledge pack from an allow-list of kb notes.

Output: ~/.local/share/automaton-knowledge/ (mounted read-only at
/root/knowledge in the container). Every note is scrubbed line by line: lines
touching private work (referral/candidates, the secretary, the owner's
personal accounts, laptop/network) are dropped, emails and phone numbers
masked, wikilinks to notes outside the pack flattened to plain text. The
build fails if any deny-listed term survives.
"""
import re
import shutil
import sys
from pathlib import Path

KB = Path.home() / "kb"
HERE = Path(__file__).resolve().parent
OUT = Path.home() / ".local/share/automaton-knowledge"

DROP_LINE = re.compile(
    r"referral|candidate|person-a|secretary|facebook|org-c|tailnet|tailscale|laptop|"
    r"\bowner'?s (personal|channel|profile|login)|salary|password|bitwarden|\.config/|/home/|~/|tắt máy|suno|telegram|piloxita hub|\bthe hub\b|vpn",
    re.I)
DENY = re.compile(r"referral|candidate|person-a|employer|laptop|tail\d{4,}|org-b|surname", re.I)
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
PHONE = re.compile(r"(?<![\w-])(?:\+\d{2}|0)\d{2}[ .]?\d{3}[ .]?\d{3,4}(?!\d)")


def scrub(text: str, keep: set[str]) -> str:
    out = []
    for line in text.splitlines():
        if DROP_LINE.search(line):
            continue
        line = re.sub(r"\b[Tt]he owner\b", "the creator", line)
        line = re.sub(r"\bowner\b", "creator", line, flags=re.I)
        line = EMAIL.sub("[email]", line)
        line = PHONE.sub("[phone]", line)
        line = re.sub(r"\[\[([^\]|]+)(\|([^\]]+))?\]\]",
                      lambda m: f"[[{m.group(1)}]]" if m.group(1) in keep else (m.group(3) or m.group(1)), line)
        out.append(line)
    return "\n".join(out) + "\n"


def main() -> int:
    notes = [l.strip() for l in (HERE / "allowlist.txt").read_text().splitlines() if l.strip() and not l.startswith("#")]
    keep = {Path(n).stem for n in notes}
    tmp = OUT.with_name(OUT.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    for n in notes:
        src = KB / n
        if not src.is_file():
            print(f"missing: {n}", file=sys.stderr)
            continue
        dst = tmp / n
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(scrub(src.read_text(encoding="utf-8"), keep))
    shutil.copy(HERE / "README.md", tmp / "README.md")
    # Private brief about the creator: kept outside the (public) repo.
    shutil.copy(Path.home() / ".config/automaton-creator/knowledge/creator-capabilities.md", tmp / "creator-capabilities.md")
    leaks = [(p, m.group(0)) for p in tmp.rglob("*.md") for m in DENY.finditer(p.read_text())]
    if leaks:
        for p, w in leaks:
            print(f"LEAK {p.relative_to(tmp)}: {w}", file=sys.stderr)
        shutil.rmtree(tmp)
        return 1
    shutil.rmtree(OUT, ignore_errors=True)
    tmp.rename(OUT)
    for p in OUT.rglob("*"):
        p.chmod(0o755 if p.is_dir() else 0o644)
    print(f"pack: {len(notes)} notes -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
