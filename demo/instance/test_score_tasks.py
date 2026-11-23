"""Tests for score_tasks.py. Run: python3 -m unittest test_score_tasks (in demo/instance)."""
import contextlib
import io
import json
import os
import tempfile
import unittest

import score_tasks as st

HERE = os.path.dirname(os.path.abspath(__file__))


def task(kind, answer=None, **kw):
    check = {"type": kind}
    if answer is not None:
        check["answer"] = answer
    check.update(kw)
    return {"id": "t", "label": "easy", "prompt": "q", "check": check}


class ExtractAnswer(unittest.TestCase):
    def test_last_answer_line_wins(self):
        self.assertEqual(st.extract_answer("ANSWER: 1\nwait, no\nANSWER: 2"), "2")

    def test_markdown_bold_and_case(self):
        self.assertEqual(st.extract_answer("Some text\n**Answer:** 42"), "42")
        self.assertTrue(st.score({"check": {"type": "exact", "answer": "Brno"}}, "answer: **Brno**"))

    def test_ignores_thinking(self):
        self.assertIsNone(st.extract_answer("<think>ANSWER: 3</think>I am not sure."))
        self.assertEqual(st.extract_answer("<think>ANSWER: 3</think>\nANSWER: 4"), "4")

    def test_missing(self):
        self.assertIsNone(st.extract_answer("The answer is 4."))
        self.assertIsNone(st.extract_answer(None))


class Score(unittest.TestCase):
    def test_any_is_none(self):
        self.assertIsNone(st.score(task("any"), "whatever"))

    def test_number(self):
        t = task("number", 4.41, tol=0.02)
        self.assertTrue(st.score(t, "so...\nANSWER: 4.4064"))
        self.assertTrue(st.score(t, "ANSWER: EUR 4.42 million"))
        self.assertFalse(st.score(t, "ANSWER: 4.5"))
        self.assertFalse(st.score(t, "no answer line, 4.41"))
        self.assertFalse(st.score(t, "ANSWER: unknown"))

    def test_number_separators_sign_percent(self):
        self.assertTrue(st.score(task("number", 470626), "ANSWER: EUR 470,626"))
        self.assertTrue(st.score(task("number", 3412), "ANSWER: 3,412 FTE"))
        self.assertTrue(st.score(task("number", 5.6, tol=0.01), "ANSWER: +5.6%"))
        self.assertTrue(st.score(task("number", -4), "ANSWER: −4"))
        self.assertTrue(st.score(task("number", 0.62), "ANSWER: .62"))
        self.assertFalse(st.score(task("number", 3412), "ANSWER: 3412.5"))

    def test_exact_normalization(self):
        t = task("exact", "apple, mango, pear")
        self.assertTrue(st.score(t, "ANSWER: Apple,mango , pear."))
        self.assertTrue(st.score(t, "ANSWER: `apple, mango, pear`"))
        self.assertFalse(st.score(t, "ANSWER: pear, mango, apple"))
        self.assertTrue(st.score(task("exact", "[2, 2, 2]"), "ANSWER: [2,2,2]"))
        self.assertTrue(st.score(task("exact", ["B", "only B"]), 'ANSWER: "b"'))

    def test_regex(self):
        t = task("regex", r"^1[\s,]+2[\s,]+1[\s,]+3$")
        self.assertTrue(st.score(t, "ANSWER: 1 2 1 3"))
        self.assertTrue(st.score(t, "ANSWER: 1, 2, 1, 3"))
        self.assertFalse(st.score(t, "ANSWER: 1 2 3 4"))

    def test_contains(self):
        t = task("contains", "184.6")
        self.assertTrue(st.score(t, "Revenue was EUR 184.6 million."))
        self.assertFalse(st.score(t, "<think>184.6</think>Revenue rose."))
        self.assertTrue(st.score(task("contains", ["a", "B"]), "b and A"))
        self.assertFalse(st.score(task("contains", ["a", "z"]), "b and A"))

    def test_unknown_type(self):
        with self.assertRaises(ValueError):
            st.score(task("fuzzy", "x"), "ANSWER: x")


class TaskFile(unittest.TestCase):
    """The shipped task set is well formed and every reference answer scores True."""

    @classmethod
    def setUpClass(cls):
        cls.tasks = st.load_tasks()
        with open(st.DEFAULT_REPORT, encoding="utf-8") as f:
            cls.report = f.read()

    def test_shape(self):
        labels = [t["label"] for t in self.tasks]
        self.assertEqual({lab: labels.count(lab) for lab in set(labels)}, {"easy": 30, "medium": 30, "hard": 30})
        self.assertEqual(len({t["id"] for t in self.tasks}), len(self.tasks))
        for t in self.tasks:
            self.assertIn(t["check"]["type"], {"exact", "number", "regex", "contains", "any"}, t["id"])
            self.assertTrue(t.get("prompt") or t.get("messages"), t["id"])
            if t["check"]["type"] in {"exact", "number", "regex"}:
                text = st.task_messages(t, self.report)[-1]["content"]
                self.assertIn("ANSWER:", text, t["id"])

    def test_report_substituted(self):
        msgs = [st.task_messages(t, self.report) for t in self.tasks]
        self.assertFalse(any("{{REPORT}}" in m["content"] for ms in msgs for m in ms))
        self.assertTrue(any("Kestrel Valve" in m["content"] for ms in msgs for m in ms))

    def test_reference_answers_score(self):
        for t in self.tasks:
            c = t["check"]
            if c["type"] in ("exact", "number"):
                ref = c["answer"][0] if isinstance(c["answer"], list) else c["answer"]
                self.assertTrue(st.score(t, f"Working...\nANSWER: {ref}"), t["id"])
                self.assertFalse(st.score(t, "I don't know."), t["id"])


class Cli(unittest.TestCase):
    def test_accuracy_by_label_and_tier(self):
        rows = [
            {"ok": True, "task_id": "e09", "label": "easy", "tier": "fast", "answer": "ANSWER: 184.6"},
            {"ok": True, "task_id": "e10", "label": "easy", "tier": "fast", "answer": "ANSWER: 1"},
            {"ok": True, "task_id": "h05", "label": "hard", "tier": "deep", "answer": "ANSWER: 2.8"},
            {"ok": True, "task_id": "e01", "label": "easy", "tier": "deep", "answer": "hello"},
            {"ok": False, "task_id": "h01", "label": "hard", "tier": "deep", "error": "HTTP 503"},
            {"ok": True, "user": 0},  # non-task row is ignored
        ]
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "out.json")
            with open(p, "w") as f:
                json.dump({"summary": {}, "rows": rows}, f)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                st.main([p, "--tasks", st.DEFAULT_TASKS, "--json"])
        res = json.loads(buf.getvalue())
        self.assertEqual(res["n_scored"], 3)
        self.assertAlmostEqual(res["all"], 0.667)
        self.assertEqual(res["by_label"]["hard"], {"accuracy": 1.0, "n": 2})
        self.assertEqual(res["by_tier"]["fast"]["accuracy"], 0.5)
        self.assertEqual(res["by_label_tier"]["easy/deep"], {"accuracy": None, "n": 1})


if __name__ == "__main__":
    unittest.main()
