"""Tests for router.py. Run: cd demo/instance && python3 -m unittest -v test_router

Fake backends are tiny stdlib servers on ephemeral ports that answer like
llama-server: GET /health, streamed SSE chat, and non-streamed judge calls.
"""

import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import router as R

KEY = "test-key-123"


# ---------------------------------------------------------------------------
# Fake llama-server
# ---------------------------------------------------------------------------

class FakeBackend:
    def __init__(self, name, words=("Hello", " from", " fake"), pause=0.0, judge="hard", judge_delay=0.0):
        self.name = name
        self.words = list(words)
        self.pause = pause              # seconds between the first chunk and the rest
        self.judge = judge
        self.judge_delay = judge_delay
        self.health = 200
        self.requests = []
        self.disconnected = threading.Event()
        fake = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_GET(self):
                data = json.dumps({"status": "ok" if fake.health == 200 else "loading"}).encode()
                self.send_response(fake.health)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fake.requests.append({"auth": self.headers.get("Authorization"), "body": body})
                if self.headers.get("Authorization") != f"Bearer {KEY}":
                    data = b'{"error":{"message":"Invalid API Key"}}'
                    self.send_response(401)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                if not body.get("stream"):
                    time.sleep(fake.judge_delay)
                    data = json.dumps({"choices": [{"message": {"content": fake.judge}}]}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    try:
                        self.wfile.write(data)
                    except OSError:
                        pass
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("X-Backend", fake.name)
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    for i, w in enumerate(fake.words):
                        chunk = {"model": fake.name, "choices": [{"index": 0, "delta": {"content": w}}]}
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                        self.wfile.flush()
                        if i == 0 and fake.pause:
                            time.sleep(fake.pause)
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    fake.disconnected.set()
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class RouterHarness:
    def __init__(self, deep, fast, policy="difficulty+spill", default="deep", judge="none",
                 slots=(4, 8), ctx=(32768, 16384), judge_timeout=R.JUDGE_TIMEOUT_S):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.tmp.name, "router.jsonl")
        self.router = R.Router(
            {"deep": {"port": deep.port, "slots": slots[0], "ctx": ctx[0]},
             "fast": {"port": fast.port, "slots": slots[1], "ctx": ctx[1]}},
            KEY, policy=policy, default=default, judge=judge, log_path=self.log,
            health_interval=0.05, judge_timeout=judge_timeout)
        self.router.check_health()
        threading.Thread(target=self.router.health_loop, daemon=True).start()
        self.server = R.Server(("127.0.0.1", 0), R.make_handler(self.router))
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.router.stop.set()
        self.server.shutdown()
        self.server.server_close()
        if self.router.log_file:
            self.router.log_file.close()
        self.tmp.cleanup()

    def request(self, method, path, body=None, key=KEY):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def chat(self, body, key=KEY):
        body = {"messages": [{"role": "user", "content": "hi"}], "stream": True, "max_tokens": 64, **body}
        return self.request("POST", "/v1/chat/completions", body, key)

    def log_lines(self):
        with open(self.log) as f:
            return [json.loads(line) for line in f if line.strip()]


def sse_text(data):
    out = []
    for line in data.decode().splitlines():
        if line.startswith("data: ") and line != "data: [DONE]":
            out.append(json.loads(line[6:])["choices"][0]["delta"].get("content", ""))
    return "".join(out)


def wait_for(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def user(text, **extra):
    return {"messages": [{"role": "user", "content": text}], **extra}


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------

class ScoreTests(unittest.TestCase):
    def test_bounds_and_easy_chat(self):
        s, f = R.score(user("hi there"))
        self.assertGreaterEqual(s, 0.0)
        self.assertLess(s, R.THRESHOLD)
        self.assertEqual(f["turns"], 1)
        s, _ = R.score({})
        self.assertEqual(s, 0.0)

    def test_longer_prompt_scores_higher(self):
        short, _ = R.score(user("tell me a story"))
        long, f = R.score(user("tell me a story " * 400))
        self.assertGreater(long, short)
        self.assertGreater(f["prompt_tokens"], 1000)

    def test_thinking_adds(self):
        off, _ = R.score(user("hello", chat_template_kwargs={"enable_thinking": False}))
        on, f = R.score(user("hello", chat_template_kwargs={"enable_thinking": True}))
        self.assertTrue(f["thinking"])
        self.assertAlmostEqual(on - off, R.W_THINKING, places=3)

    def test_cues(self):
        _, f = R.score(user("Prove the theorem, then write a Python function and compare both."))
        self.assertEqual(set(f["cues"]), {"proof", "code", "compare"})
        plain, _ = R.score(user("What a nice day it is."))
        cued, _ = R.score(user("Calculate and explain why the equation holds."))
        self.assertGreater(cued, plain)

    def test_digits(self):
        words, _ = R.score(user("add these numbers together please"))
        digits, f = R.score(user("add 1234 5678 9012 3456 7890 please"))
        self.assertGreater(f["digit_density"], 0.3)
        self.assertGreater(digits, words)

    def test_document_with_analytic_question(self):
        doc = "<document>" + "Revenue grew in the north region. " * 80 + "</document>"
        without_q, f1 = R.score(user(doc + "\nThanks."))
        with_q, f2 = R.score(user(doc + "\nAnalyse the main risks and compare the regions."))
        self.assertTrue(f1["long_doc"] and f2["long_doc"])
        self.assertTrue(f2["analytic"])
        self.assertGreaterEqual(with_q - without_q, R.W_DOC_QUESTION)

    def test_turns(self):
        msgs = []
        for i in range(6):
            msgs += [{"role": "user", "content": "ok"}, {"role": "assistant", "content": "ok"}]
        one, _ = R.score(user("ok"))
        many, f = R.score({"messages": msgs})
        self.assertEqual(f["turns"], 6)
        self.assertGreater(many, one)

    def test_content_parts(self):
        _, f = R.score({"messages": [{"role": "user", "content": [{"type": "text", "text": "prove it"}]}]})
        self.assertIn("proof", f["cues"])

    def test_hard_request_crosses_threshold(self):
        s, _ = R.score(user("Prove that the sum of the first 100 odd numbers is 10000, step by step.",
                            chat_template_kwargs={"enable_thinking": True}))
        self.assertGreaterEqual(s, R.THRESHOLD)


# ---------------------------------------------------------------------------
# Routing decisions (pure)
# ---------------------------------------------------------------------------

TIERS = {"deep": {"slots": 4, "ctx": 32768}, "fast": {"slots": 8, "ctx": 16384}}
UP = {"deep": True, "fast": True}
IDLE = {"deep": 0, "fast": 0}


class ChooseTests(unittest.TestCase):
    def test_policies(self):
        self.assertEqual(R.choose("deep-only", 0.0, 100, TIERS, UP, IDLE), ("deep", "policy"))
        self.assertEqual(R.choose("fast-only", 1.0, 100, TIERS, UP, IDLE), ("fast", "policy"))
        self.assertEqual(R.choose("random:0.3", 0.0, 100, TIERS, UP, IDLE, rng=lambda: 0.1), ("deep", "random"))
        self.assertEqual(R.choose("random:0.3", 0.0, 100, TIERS, UP, IDLE, rng=lambda: 0.5), ("fast", "random"))
        self.assertEqual(R.choose("difficulty", 0.7, 100, TIERS, UP, IDLE), ("deep", "hard"))
        self.assertEqual(R.choose("difficulty", 0.2, 100, TIERS, UP, IDLE), ("fast", "easy"))

    def test_parse_policy(self):
        self.assertEqual(R.parse_policy("random:0.50"), "random:0.5")
        for bad in ("nope", "random:2", "random:x", ""):
            with self.assertRaises(ValueError):
                R.parse_policy(bad)

    def test_context_fit_excludes_small_tier(self):
        # 20k tokens do not fit fast's 16k slot: even an easy request goes deep.
        self.assertEqual(R.choose("difficulty", 0.1, 20000, TIERS, UP, IDLE), ("deep", "context-fit"))
        self.assertEqual(R.choose("fast-only", 0.1, 20000, TIERS, UP, IDLE), ("deep", "context-fit"))
        # Fits nowhere: the biggest context.
        self.assertEqual(R.choose("difficulty", 0.1, 99999, TIERS, UP, IDLE), ("deep", "no-fit"))

    def test_unhealthy_excluded(self):
        self.assertEqual(R.choose("difficulty", 0.9, 100, TIERS, {"deep": False, "fast": True}, IDLE),
                         ("fast", "unhealthy-other"))
        self.assertEqual(R.choose("difficulty", 0.9, 100, TIERS, {"deep": False, "fast": False}, IDLE),
                         (None, "no-healthy-backend"))

    def test_spill(self):
        busy_deep = {"deep": 5, "fast": 0}
        self.assertEqual(R.choose("difficulty+spill", 0.6, 100, TIERS, UP, busy_deep), ("fast", "spill"))
        # Same load without spill policy stays.
        self.assertEqual(R.choose("difficulty", 0.6, 100, TIERS, UP, busy_deep), ("deep", "hard"))
        # Very hard requests never spill.
        self.assertEqual(R.choose("difficulty+spill", 0.9, 100, TIERS, UP, busy_deep), ("deep", "hard"))
        # Deep still has a free slot: no spill.
        self.assertEqual(R.choose("difficulty+spill", 0.6, 100, TIERS, UP, {"deep": 3, "fast": 0}), ("deep", "hard"))
        # Both queueing equally: no spill.
        self.assertEqual(R.choose("difficulty+spill", 0.6, 100, TIERS, UP, {"deep": 6, "fast": 10}), ("deep", "hard"))
        # Easy requests spill to deep when fast is the one queueing.
        self.assertEqual(R.choose("difficulty+spill", 0.1, 100, TIERS, UP, {"deep": 0, "fast": 9}), ("deep", "spill"))
        # No spill to a tier the prompt does not fit.
        self.assertEqual(R.choose("difficulty+spill", 0.6, 20000, TIERS, UP, busy_deep), ("deep", "context-fit"))


# ---------------------------------------------------------------------------
# HTTP, against fake backends
# ---------------------------------------------------------------------------

class HttpTests(unittest.TestCase):
    def setUp(self):
        self.deep = FakeBackend("deep-model", words=("Deep", " answer"))
        self.fast = FakeBackend("fast-model", words=("Fast", " answer"))
        self.h = RouterHarness(self.deep, self.fast)

    def tearDown(self):
        self.h.close()
        for b in (self.deep, self.fast):
            try:
                b.stop()
            except OSError:
                pass

    def test_auth(self):
        r, data = self.h.chat({}, key=None)
        self.assertEqual(r.status, 401)
        r, _ = self.h.chat({}, key="wrong")
        self.assertEqual(r.status, 401)
        r, _ = self.h.request("GET", "/router/stats", key=None)
        self.assertEqual(r.status, 401)
        r, _ = self.h.request("GET", "/v1/models", key="nope")
        self.assertEqual(r.status, 401)
        r, _ = self.h.request("GET", "/health", key=None)
        self.assertEqual(r.status, 200)
        self.assertEqual(self.deep.requests, [])

    def test_passthrough_and_headers(self):
        r, data = self.h.chat({"model": "deep"})
        self.assertEqual(r.status, 200)
        self.assertEqual(sse_text(data), "Deep answer")
        self.assertIn("data: [DONE]", data.decode())
        self.assertEqual(r.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(r.getheader("X-Backend"), "deep-model")
        self.assertEqual(r.getheader("x-locus-tier"), "deep")
        self.assertEqual(r.getheader("x-locus-reason"), "explicit")
        self.assertRegex(r.getheader("x-locus-score"), r"^\d\.\d{3}$")
        r, data = self.h.chat({"model": "fast"})
        self.assertEqual(sse_text(data), "Fast answer")
        self.assertEqual(r.getheader("x-locus-tier"), "fast")

    def test_default_tier_when_model_absent(self):
        r, data = self.h.chat({})
        self.assertEqual(r.getheader("x-locus-tier"), "deep")
        self.assertEqual(sse_text(data), "Deep answer")

    def test_strips_router_fields(self):
        self.h.chat({"model": "auto", "router_policy": "fast-only", "router_judge": "none", "temperature": 0.3})
        fwd = self.fast.requests[-1]
        self.assertEqual(fwd["auth"], f"Bearer {KEY}")
        for k in ("model", "router_policy", "router_judge"):
            self.assertNotIn(k, fwd["body"])
        self.assertEqual(fwd["body"]["temperature"], 0.3)
        self.assertTrue(fwd["body"]["stream"])

    def test_policy_override_and_auto_difficulty(self):
        r, _ = self.h.chat({"model": "auto", "router_policy": "deep-only"})
        self.assertEqual(r.getheader("x-locus-tier"), "deep")
        r, _ = self.h.chat({"model": "auto"})  # "hi": easy
        self.assertEqual((r.getheader("x-locus-tier"), r.getheader("x-locus-reason")), ("fast", "easy"))
        hard = user("Prove that the sum of the first 100 odd numbers is 10000, step by step.",
                    chat_template_kwargs={"enable_thinking": True})
        r, _ = self.h.chat({"model": "auto", **hard})
        self.assertEqual((r.getheader("x-locus-tier"), r.getheader("x-locus-reason")), ("deep", "hard"))
        r, _ = self.h.chat({"model": "auto", "router_policy": "bogus"})
        self.assertEqual(r.status, 400)
        r, _ = self.h.chat({"model": "gpt-4"})
        self.assertEqual(r.status, 400)

    def test_streams_without_buffering(self):
        self.deep.pause = 0.8
        c = http.client.HTTPConnection("127.0.0.1", self.h.port, timeout=10)
        t0 = time.monotonic()
        c.request("POST", "/v1/chat/completions",
                  body=json.dumps({"model": "deep", "stream": True, "messages": [{"role": "user", "content": "x"}]}),
                  headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        r = c.getresponse()
        first = r.read1(65536)
        t_first = time.monotonic() - t0
        rest = r.read()
        t_all = time.monotonic() - t0
        c.close()
        self.assertIn(b"Deep", first)
        self.assertLess(t_first, 0.5)
        self.assertGreater(t_all, 0.7)
        self.assertEqual(sse_text(first + rest), "Deep answer")
        line = self.h.log_lines()[-1]
        self.assertLess(line["ttft_s"], 0.5)
        self.assertGreater(line["latency_s"], 0.7)

    def test_backend_down(self):
        self.deep.stop()
        self.assertTrue(wait_for(lambda: not self.h.router.healthy["deep"]))
        r, data = self.h.request("GET", "/health", key=None)
        self.assertEqual(r.status, 503)
        self.assertEqual(json.loads(data)["backends"]["deep"]["healthy"], False)
        r, data = self.h.chat({"model": "deep"})
        self.assertEqual(r.status, 503)
        self.assertEqual(json.loads(data)["error"]["code"], 503)
        hard = user("Prove it step by step: 12345 * 6789", chat_template_kwargs={"enable_thinking": True})
        r, data = self.h.chat({"model": "auto", **hard})
        self.assertEqual(r.status, 200)
        self.assertEqual((r.getheader("x-locus-tier"), r.getheader("x-locus-reason")), ("fast", "unhealthy-other"))
        self.assertEqual(sse_text(data), "Fast answer")
        # A loading backend (503 on /health) counts as unhealthy too, and comes back.
        self.fast.health = 503
        self.assertTrue(wait_for(lambda: not self.h.router.healthy["fast"]))
        r, _ = self.h.chat({"model": "auto"})
        self.assertEqual(r.status, 503)
        self.fast.health = 200
        self.assertTrue(wait_for(lambda: self.h.router.healthy["fast"]))

    def test_connect_error_is_502(self):
        self.deep.stop()
        self.h.router.stop.set()                    # freeze health so the router still thinks deep is up
        time.sleep(0.2)
        with self.h.router.lock:
            self.h.router.healthy["deep"] = True
        r, data = self.h.chat({"model": "deep"})
        self.assertEqual(r.status, 502)
        self.assertEqual(json.loads(data)["error"]["type"], "upstream_error")
        self.assertFalse(self.h.router.healthy["deep"])
        self.assertEqual(self.h.router.stats()["tiers"]["deep"]["errors"], 1)

    def test_client_disconnect_closes_upstream(self):
        self.deep.words = ["w"] * 2000
        self.deep.pause = 0.3
        c = http.client.HTTPConnection("127.0.0.1", self.h.port, timeout=10)
        c.request("POST", "/v1/chat/completions",
                  body=json.dumps({"model": "deep", "stream": True, "messages": [{"role": "user", "content": "x"}]}),
                  headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        r = c.getresponse()
        r.read1(100)
        c.sock.close() if c.sock else None
        r.close()
        c.close()
        self.assertTrue(self.deep.disconnected.wait(5), "backend never saw the disconnect")
        self.assertTrue(wait_for(lambda: self.h.router.stats()["tiers"]["deep"]["inflight"] == 0))
        self.assertTrue(wait_for(lambda: any(l["status"] == 499 for l in self.h.log_lines())))

    def test_stats_and_log(self):
        self.h.chat({"model": "deep"})
        self.h.chat({"model": "auto"})
        r, data = self.h.request("GET", "/router/stats")
        stats = json.loads(data)
        self.assertEqual(set(stats), {"tiers", "spills", "decisions", "judge_calls", "judge_ms_mean"})
        self.assertEqual(stats["tiers"]["deep"], {"inflight": 0, "slots": 4, "routed": 1, "errors": 0})
        self.assertEqual(stats["tiers"]["fast"]["routed"], 1)
        self.assertEqual(stats["decisions"], 2)
        lines = self.h.log_lines()
        self.assertEqual(len(lines), 2)
        for k in ("ts", "policy", "requested", "tier", "score", "reason", "features", "inflight",
                  "ttft_s", "latency_s", "status"):
            self.assertIn(k, lines[0])
        self.assertEqual(lines[0]["status"], 200)
        self.assertEqual(lines[1]["requested"], "auto")
        r, data = self.h.request("GET", "/v1/models")
        self.assertEqual([m["id"] for m in json.loads(data)["data"]], ["auto", "deep", "fast"])


class JudgeTests(unittest.TestCase):
    def tearDown(self):
        self.h.close()
        self.deep.stop()
        self.fast.stop()

    def test_judge_blends(self):
        self.deep = FakeBackend("deep-model")
        self.fast = FakeBackend("fast-model", judge="hard")
        self.h = RouterHarness(self.deep, self.fast, judge="fast")
        h_score, _ = R.score(user("hi"))
        r, _ = self.h.chat({"model": "auto"})
        judge_req = self.fast.requests[0]["body"]
        self.assertEqual(judge_req["max_tokens"], 1)
        self.assertEqual(judge_req["temperature"], 0)
        self.assertEqual(judge_req["grammar"], R.JUDGE_GRAMMAR)
        self.assertFalse(judge_req["stream"])
        self.assertEqual(judge_req["chat_template_kwargs"], {"enable_thinking": False})
        expected = round(R.JUDGE_WEIGHT * R.JUDGE_HARD + (1 - R.JUDGE_WEIGHT) * h_score, 3)
        self.assertEqual(float(r.getheader("x-locus-score")), expected)
        stats = self.h.router.stats()
        self.assertEqual(stats["judge_calls"], 1)
        self.assertIsNotNone(stats["judge_ms_mean"])
        self.assertIn("judge_ms", self.h.log_lines()[-1])

    def test_judge_timeout_falls_back(self):
        self.deep = FakeBackend("deep-model")
        self.fast = FakeBackend("fast-model", judge="hard", judge_delay=1.0)
        self.h = RouterHarness(self.deep, self.fast, judge_timeout=0.2)
        h_score, _ = R.score(user("hi"))
        t0 = time.monotonic()
        r, _ = self.h.chat({"model": "auto", "router_judge": "fast"})
        self.assertLess(time.monotonic() - t0, 0.9)
        self.assertEqual(r.status, 200)
        self.assertEqual(float(r.getheader("x-locus-score")), h_score)
        line = self.h.log_lines()[-1]
        self.assertIsNone(line["features"]["judge"])
        self.assertGreaterEqual(line["judge_ms"], 150)
        self.assertEqual(self.h.router.stats()["judge_calls"], 1)


class CliTests(unittest.TestCase):
    def test_parse_backend(self):
        self.assertEqual(R.parse_backend("deep=8081:4:32768"), ("deep", {"port": 8081, "slots": 4, "ctx": 32768}))
        for bad in ("deep=8081:4", "other=1:1:1", "deep:8081:4:1"):
            with self.assertRaises(Exception):
                R.parse_backend(bad)


if __name__ == "__main__":
    unittest.main()
