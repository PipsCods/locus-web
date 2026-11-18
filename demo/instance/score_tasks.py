#!/usr/bin/env python3
"""Score answers to the labelled tasks in prompts/tiered-tasks.jsonl.

Each task has a check {type, answer, tol?}:
  exact     the final ANSWER value equals answer (or one of a list), ignoring
            case, markdown, quotes, a trailing full stop and spaces next to
            punctuation
  number    the first number in the ANSWER value is within tol (default 1e-6)
            of answer; thousands separators, currency and % are ignored
  regex     the ANSWER value matches the pattern (case-insensitive)
  contains  the whole reply contains answer (or every item of a list),
            case-insensitive; no ANSWER line needed
  any       not checkable (free chat): score() returns None

The ANSWER value is taken from the last line of the reply that reads
"ANSWER: <value>" (markdown bold allowed). Text inside <think>...</think> is
ignored. A reply without an ANSWER line scores False for exact/number/regex.

As a library (loadgen.py): load_tasks(), task_messages(), score().
As a CLI: score_tasks.py LOADGEN_OUTPUT.json [...] [--tasks FILE] prints
accuracy overall, by label, by tier and by label x tier. Rows that carry an
"answer" text are re-scored against --tasks (if given); otherwise the row's
"correct" field is used. Failed requests are left out of accuracy (loadgen
counts them as failed).

Stdlib only: runs with the image's python3.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TASKS = os.path.join(HERE, "prompts", "tiered-tasks.jsonl")
DEFAULT_REPORT = os.path.join(HERE, "prompts", "sample-report.txt")

_THINK = re.compile(r"<think>.*?(</think>|$)", re.S | re.I)
_ANSWER = re.compile(r"^[\s>*_#`-]*answer[\s*_`]*[:：][\s*_`]*(.*?)\s*$", re.I | re.M)
_NUMBER = re.compile(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?", re.I)


def load_tasks(path=DEFAULT_TASKS):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def task_messages(task, report=""):
    """Chat messages for a task, with {{REPORT}} replaced by the report text."""
    if task.get("messages"):
        return [dict(m, content=m["content"].replace("{{REPORT}}", report)) for m in task["messages"]]
    return [{"role": "user", "content": task["prompt"].replace("{{REPORT}}", report)}]


def strip_thinking(text):
    return _THINK.sub("", text or "")


def extract_answer(text):
    """The value of the last 'ANSWER: <value>' line, or None."""
    found = _ANSWER.findall(strip_thinking(text))
    return found[-1] if found else None


def _clean(v):
    v = v.strip().replace("**", "").replace("__", "").strip("`*_ \t")
    v = v.strip("\"'“”‘’").strip()
    return v.rstrip(".").strip()


def _norm(v):
    v = re.sub(r"\s+", " ", _clean(v).lower())
    return re.sub(r"\s*([,()\[\]{}:;/])\s*", r"\1", v)


def parse_number(v):
    v = _clean(v).replace("−", "-").replace("–", "-")
    v = re.sub(r"(?<=\d)[,  '](?=\d{3}(?!\d))", "", v)  # 1,234,567 -> 1234567
    m = _NUMBER.search(v)
    return float(m.group(0)) if m else None


def _as_list(a):
    return a if isinstance(a, list) else [a]


def score(task, answer_text):
    """True/False for checkable tasks, None for check type 'any'."""
    check = task.get("check") or {"type": "any"}
    kind = check.get("type", "any")
    if kind == "any":
        return None
    if kind == "contains":
        body = strip_thinking(answer_text).lower()
        return all(str(a).lower() in body for a in _as_list(check["answer"]))
    value = extract_answer(answer_text)
    if value is None:
        return False
    if kind == "exact":
        return _norm(value) in {_norm(str(a)) for a in _as_list(check["answer"])}
    if kind == "number":
        got = parse_number(value)
        if got is None:
            return False
        tol = float(check.get("tol", 1e-6))
        return any(abs(got - float(a)) <= tol + 1e-9 for a in _as_list(check["answer"]))
    if kind == "regex":
        return re.search(check["answer"], _clean(value), re.I) is not None
    raise ValueError(f"unknown check type: {kind}")


def accuracy(rows):
    """Share of scored rows (correct is True/False) that are correct, or None."""
    vals = [r["correct"] for r in rows if r.get("correct") is not None]
    return round(sum(vals) / len(vals), 3) if vals else None


def _table(rows):
    out = {"all": accuracy(rows), "n_scored": sum(1 for r in rows if r.get("correct") is not None)}
    for key in ("label", "tier"):
        groups = {}
        for r in rows:
            groups.setdefault(r.get(key) or "?", []).append(r)
        out[f"by_{key}"] = {k: {"accuracy": accuracy(v), "n": len(v)} for k, v in sorted(groups.items())}
    cross = {}
    for r in rows:
        cross.setdefault(f"{r.get('label') or '?'}/{r.get('tier') or '?'}", []).append(r)
    out["by_label_tier"] = {k: {"accuracy": accuracy(v), "n": len(v)} for k, v in sorted(cross.items())}
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Accuracy of a loadgen.py --workload tasks output.")
    ap.add_argument("files", nargs="+", help="loadgen output JSON ({summary, rows}) or a JSONL of rows")
    ap.add_argument("--tasks", help="task file to re-score rows that carry 'answer' text")
    ap.add_argument("--json", action="store_true", help="print JSON instead of a table")
    a = ap.parse_args(argv)
    tasks = {t["id"]: t for t in load_tasks(a.tasks)} if a.tasks else {}

    rows = []
    for path in a.files:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        try:
            doc = json.loads(text)
            got = doc.get("rows", []) if isinstance(doc, dict) else doc
        except ValueError:
            got = [json.loads(line) for line in text.splitlines() if line.strip()]
        rows += [r for r in got if r.get("task_id")]
    for r in rows:
        t = tasks.get(r["task_id"])
        if not r.get("ok", True):
            r["correct"] = None  # failed requests are counted as failures, not as wrong answers
        elif t is not None and "answer" in r:
            r["correct"] = score(t, r["answer"])
    res = _table(rows)
    if a.json:
        print(json.dumps(res, indent=1))
        return 0
    print(f"tasks rows: {len(rows)}, scored: {res['n_scored']}, accuracy: {res['all']}")
    for key in ("by_label", "by_tier", "by_label_tier"):
        print(f"\n{key[3:]:<14} accuracy   n")
        for k, v in res[key].items():
            acc = "-" if v["accuracy"] is None else f"{v['accuracy']:.3f}"
            print(f"{k:<14} {acc:>8} {v['n']:>4}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
