#!/usr/bin/env python3
"""locus tier router: one OpenAI-style endpoint in front of several llama-servers.

Runs on the demo machine at 127.0.0.1:8080 (the tunnel target). Each request
goes to a tier ("deep" or "fast"), picked from body.model:

  deep | fast   that tier (503 if it is unhealthy)
  auto          picked by the policy below
  (absent)      --default

Policies (--policy, or per request "router_policy"):
  deep-only, fast-only   always that tier
  random:P               deep with probability P
  difficulty             deep if score(body) >= THRESHOLD, else fast
  difficulty+spill       difficulty, then move the request to the other tier
                         when the chosen one is queueing and the other is not

Before any policy, tiers that are unhealthy or whose per-slot context cannot
hold the prompt plus max_tokens are excluded. "router_judge": "fast" (or
--judge fast) adds a one-token easy/hard verdict from the fast tier to the
heuristic score.

Endpoints: POST /v1/chat/completions, GET /v1/models, GET /router/stats (all
need the bearer key), GET /health (no key; 200 only when every backend is).
Responses stream through unchanged, with x-locus-tier / x-locus-score /
x-locus-reason headers added. One JSON line per request goes to --log.

Stdlib only:
  python3 router.py --port 8080 --key-file /run/locus/api-key \\
    --backend deep=8081:4:32768 --backend fast=8082:8:16384 \\
    --policy difficulty+spill --default deep [--judge none|fast] \\
    [--log /var/lib/locus/router.jsonl] [--host 127.0.0.1]
"""

import argparse
import hmac
import http.client
import json
import math
import random
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# Tunables. The classifier weights and THRESHOLD are tuned on the labelled
# task set (prompts/tiered-tasks.jsonl) and nowhere else.
# ---------------------------------------------------------------------------

# score(body) is the clamped sum of these contributions, each in [0, weight].
W_TOKENS = 0.20          # prompt length, log-scaled between TOKENS_LO and TOKENS_HI
TOKENS_LO = 50
TOKENS_HI = 16000
W_THINKING = 0.30        # chat_template_kwargs.enable_thinking is true
W_CUE = 0.12             # per cue category found in the last user message ...
CUES_MAX = 0.36          # ... capped here
W_DIGITS = 0.12          # digit share of the last user message, saturating at DIGITS_SAT
DIGITS_SAT = 0.08
W_DOC_QUESTION = 0.25    # a long document plus an analytic question about it
LONG_DOC_CHARS = 2000
W_TURN = 0.03            # per user turn after the first ...
TURNS_MAX = 0.12         # ... capped here
THRESHOLD = 0.5          # score >= THRESHOLD is "hard" (deep tier)

# Spill (difficulty+spill): when the chosen tier has no free slot and its queue
# is longer than the other tier's by more than SPILL_K (a tier with free slots
# counts as a negative queue), move the request unless score >= HARD_CEILING.
SPILL_K = 1
HARD_CEILING = 0.85

# Judge (classifier v2): one token from the fast tier, blended with the heuristic.
JUDGE_TIMEOUT_S = 2.0
JUDGE_MAX_CHARS = 1500
JUDGE_WEIGHT = 0.5       # final = JUDGE_WEIGHT * verdict + (1 - JUDGE_WEIGHT) * heuristic
JUDGE_EASY = 0.2
JUDGE_HARD = 0.8
JUDGE_SYSTEM = (
    "You sort requests for two assistants. Answer easy if a small, fast model can answer "
    "well: chit-chat, simple facts, short rewrites, simple lookups. Answer hard if it needs "
    "careful multi-step reasoning, maths, code, a proof, or analysis of a long document."
)
JUDGE_GRAMMAR = 'root ::= "easy" | "hard"'

CHARS_PER_TOKEN = 3.5
DEFAULT_MAX_TOKENS = 1024   # assumed for the context-fit rule when the body has none
HEALTH_INTERVAL_S = 2.0
UPSTREAM_TIMEOUT_S = 900    # socket timeout; a 32k prefill under load can take minutes
MAX_BODY_BYTES = 8 << 20
STRIP_FIELDS = ("model", "router_policy", "router_judge")
TIERS = ("deep", "fast")

CUES = {
    "reasoning": r"\bwhy\b|\bexplain|\breason|step[- ]by[- ]step|\btrade-?offs?\b|\bplan\b",
    "maths": r"\bcalculat|\bcompute|\bsolve|\bequation|\bpercent|\baverage|\bprobabilit|\bintegral|\bderivative|\bsum of\b|\bhow many\b|\bhow much\b",
    "code": r"\bcode\b|\bfunction\b|\bpython\b|\bjavascript\b|\bsql\b|\bregex|\bbug\b|\bdebug|\balgorithm|\bcompile|\bstack trace|```",
    "extraction": r"\bextract|\blist (all|every)|\bfind (all|every)|\bin (a )?table\b|\bas json\b|\bfrom the (document|report|text)\b",
    "proof": r"\bprove\b|\bproof\b|\bderive\b|\btheorem\b|\blemma\b",
    "compare": r"\bcompare|\bcontrast|\bdifference between\b|\bversus\b|\bvs\.?\b|\bpros and cons\b",
    "analyse": r"\banaly[sz]|\bevaluat|\bassess|\bimplication|\broot cause\b|\bcritique\b",
}
CUE_RES = {k: re.compile(v, re.I) for k, v in CUES.items()}


# ---------------------------------------------------------------------------
# Classifier and routing (pure functions, unit-tested)
# ---------------------------------------------------------------------------

def message_text(msg):
    """Text of one chat message; content may be a string or a list of parts."""
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict) and isinstance(p.get("text"), str))
    return ""


def messages_of(body):
    msgs = body.get("messages")
    return [m for m in msgs if isinstance(m, dict)] if isinstance(msgs, list) else []


def last_user_text(body):
    for m in reversed(messages_of(body)):
        if m.get("role") == "user":
            return message_text(m)
    return ""


def prompt_tokens(body):
    chars = sum(len(message_text(m)) for m in messages_of(body))
    return int(math.ceil(chars / CHARS_PER_TOKEN))


def max_tokens_of(body):
    for k in ("max_tokens", "max_completion_tokens", "n_predict"):
        v = body.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            return int(v)
    return DEFAULT_MAX_TOKENS


def thinking_requested(body):
    kw = body.get("chat_template_kwargs")
    return isinstance(kw, dict) and kw.get("enable_thinking") is True


def score(body):
    """Heuristic difficulty in [0, 1] -> (score, features). Higher = harder."""
    msgs = messages_of(body)
    last = last_user_text(body)
    tokens = prompt_tokens(body)
    cues = sorted(k for k, rx in CUE_RES.items() if rx.search(last))
    digits = sum(c.isdigit() for c in last)
    density = digits / len(last) if last else 0.0
    long_doc = any("<document>" in message_text(m) or len(message_text(m)) > LONG_DOC_CHARS for m in msgs)
    analytic = bool(set(cues) - {"code"}) or bool(re.search(r"\?\s*$", last.strip()[-200:] if last else ""))
    turns = sum(1 for m in msgs if m.get("role") == "user")
    thinking = thinking_requested(body)

    span = math.log(TOKENS_HI) - math.log(TOKENS_LO)
    tok_part = min(1.0, max(0.0, (math.log(max(tokens, 1)) - math.log(TOKENS_LO)) / span)) * W_TOKENS
    parts = {
        "tokens": tok_part,
        "thinking": W_THINKING if thinking else 0.0,
        "cues": min(CUES_MAX, W_CUE * len(cues)),
        "digits": min(1.0, density / DIGITS_SAT) * W_DIGITS,
        "doc_question": W_DOC_QUESTION if long_doc and analytic else 0.0,
        "turns": min(TURNS_MAX, W_TURN * max(0, turns - 1)),
    }
    s = round(min(1.0, max(0.0, sum(parts.values()))), 3)
    features = {
        "prompt_tokens": tokens,
        "thinking": thinking,
        "cues": cues,
        "digit_density": round(density, 4),
        "long_doc": long_doc,
        "analytic": analytic,
        "turns": turns,
        "parts": {k: round(v, 3) for k, v in parts.items()},
    }
    return s, features


def parse_policy(p):
    """Validate a policy string; returns it normalised or raises ValueError."""
    p = (p or "").strip()
    if p in ("deep-only", "fast-only", "difficulty", "difficulty+spill"):
        return p
    if p.startswith("random:"):
        prob = float(p.split(":", 1)[1])
        if not 0.0 <= prob <= 1.0:
            raise ValueError("random:P needs 0 <= P <= 1")
        return f"random:{prob:g}"
    raise ValueError(f"unknown policy {p!r}")


def needs_score(policy):
    return policy.startswith("difficulty")


def other_tier(tier, tiers):
    return next((t for t in tiers if t != tier), tier)


def choose(policy, sc, need_tokens, tiers, healthy, inflight, rng=random.random):
    """Pick a tier for an auto request -> (tier, reason), or (None, reason) when none is usable.

    tiers: {name: {"slots": int, "ctx": int}}; healthy: {name: bool}; inflight: {name: int}.
    """
    up = [t for t in tiers if healthy.get(t)]
    if not up:
        return None, "no-healthy-backend"
    fit = [t for t in up if tiers[t]["ctx"] >= need_tokens]
    if not fit:
        # Nothing fits: the biggest context has the best chance (the server truncates or errors).
        return max(up, key=lambda t: tiers[t]["ctx"]), "no-fit"
    if len(fit) == 1:
        only = fit[0]
        return only, ("unhealthy-other" if len(up) == 1 and len(tiers) > 1 else "context-fit")

    if policy in ("deep-only", "fast-only"):
        want = policy.split("-")[0]
        return (want, "policy") if want in fit else (fit[0], "policy-fallback")
    if policy.startswith("random:"):
        p = float(policy.split(":", 1)[1])
        want = "deep" if rng() < p else "fast"
        return (want, "random") if want in fit else (other_tier(want, fit), "random")

    want = "deep" if sc >= THRESHOLD else "fast"
    reason = "hard" if want == "deep" else "easy"
    if want not in fit:
        want = other_tier(want, fit)
    if policy == "difficulty+spill" and sc < HARD_CEILING:
        alt = other_tier(want, fit)
        if alt != want and inflight.get(want, 0) >= tiers[want]["slots"]:
            queue = inflight.get(want, 0) - tiers[want]["slots"]
            alt_queue = inflight.get(alt, 0) - tiers[alt]["slots"]   # negative = free slots
            if queue - alt_queue > SPILL_K:
                return alt, "spill"
    return want, reason


# ---------------------------------------------------------------------------
# Router state
# ---------------------------------------------------------------------------

class Router:
    def __init__(self, backends, key, policy="difficulty+spill", default="deep", judge="none",
                 log_path=None, backend_host="127.0.0.1", health_interval=HEALTH_INTERVAL_S,
                 judge_timeout=JUDGE_TIMEOUT_S):
        self.tiers = backends            # {name: {"port", "slots", "ctx"}}
        self.key = key
        self.policy = parse_policy(policy)
        self.default = default
        self.judge = judge
        self.backend_host = backend_host
        self.health_interval = health_interval
        self.judge_timeout = judge_timeout
        self.lock = threading.Lock()
        self.log_lock = threading.Lock()
        self.log_file = open(log_path, "a", buffering=1) if log_path else None
        self.healthy = {t: False for t in backends}
        self.inflight = {t: 0 for t in backends}
        self.routed = {t: 0 for t in backends}
        self.errors = {t: 0 for t in backends}
        self.spills = 0
        self.decisions = 0
        self.judge_calls = 0
        self.judge_ms_total = 0.0
        self.stop = threading.Event()

    # -- health ------------------------------------------------------------
    def check_health(self):
        for t, b in self.tiers.items():
            ok = False
            c = http.client.HTTPConnection(self.backend_host, b["port"], timeout=2)
            try:
                c.request("GET", "/health")
                r = c.getresponse()
                r.read()
                ok = r.status == 200
            except (OSError, http.client.HTTPException):
                ok = False
            finally:
                c.close()
            with self.lock:
                self.healthy[t] = ok

    def health_loop(self):
        while not self.stop.wait(self.health_interval):
            self.check_health()

    def mark_down(self, tier):
        with self.lock:
            self.healthy[tier] = False

    # -- judge -------------------------------------------------------------
    def ask_judge(self):
        """Returns a callable body -> (verdict score or None, ms)."""
        def run(body):
            t0 = time.monotonic()
            verdict = None
            c = None
            try:
                req = {
                    "messages": [
                        {"role": "system", "content": JUDGE_SYSTEM},
                        {"role": "user", "content": last_user_text(body)[:JUDGE_MAX_CHARS]},
                    ],
                    "max_tokens": 1,
                    "temperature": 0,
                    "grammar": JUDGE_GRAMMAR,
                    "chat_template_kwargs": {"enable_thinking": False},
                    "stream": False,
                }
                c = http.client.HTTPConnection(self.backend_host, self.tiers["fast"]["port"], timeout=self.judge_timeout)
                c.request("POST", "/v1/chat/completions", body=json.dumps(req),
                          headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.key}"})
                r = c.getresponse()
                data = r.read()
                if r.status == 200 and time.monotonic() - t0 <= self.judge_timeout:
                    text = json.loads(data)["choices"][0]["message"]["content"].strip().lower()
                    if text.startswith("h"):
                        verdict = JUDGE_HARD
                    elif text.startswith("e"):
                        verdict = JUDGE_EASY
            except (OSError, http.client.HTTPException, ValueError, KeyError, IndexError, TypeError):
                verdict = None
            finally:
                if c is not None:
                    c.close()
            ms = (time.monotonic() - t0) * 1000
            with self.lock:
                self.judge_calls += 1
                self.judge_ms_total += ms
            return verdict, ms
        return run

    # -- stats and log -----------------------------------------------------
    def stats(self):
        with self.lock:
            return {
                "tiers": {t: {"inflight": self.inflight[t], "slots": b["slots"],
                              "routed": self.routed[t], "errors": self.errors[t]}
                          for t, b in self.tiers.items()},
                "spills": self.spills,
                "decisions": self.decisions,
                "judge_calls": self.judge_calls,
                "judge_ms_mean": round(self.judge_ms_total / self.judge_calls, 1) if self.judge_calls else None,
            }

    def write_log(self, rec):
        if not self.log_file:
            return
        line = json.dumps(rec, separators=(",", ":"))
        with self.log_lock:
            self.log_file.write(line + "\n")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "content-length", "proxy-connection",
              "te", "trailer", "upgrade"}


class ClientGone(Exception):
    pass


def make_handler(router):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "locus-router"
        sys_version = ""

        def log_message(self, fmt, *args):   # quiet: the decision log has the details
            pass

        # -- helpers ---------------------------------------------------------
        def send_json(self, status, obj, extra=None):
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def error(self, status, message, kind="invalid_request_error", extra=None):
            self.send_json(status, {"error": {"code": status, "message": message, "type": kind}}, extra)

        def authorized(self):
            auth = self.headers.get("Authorization", "")
            given = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
            if hmac.compare_digest(given.encode(), router.key.encode()):
                return True
            self.error(401, "Invalid API Key", "authentication_error")
            return False

        def write(self, data):
            try:
                self.wfile.write(data)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as e:
                raise ClientGone() from e

        # -- GET -------------------------------------------------------------
        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/health":
                with router.lock:
                    healthy = dict(router.healthy)
                ok = all(healthy.values())
                self.send_json(200 if ok else 503, {
                    "status": "ok" if ok else "unavailable",
                    "backends": {t: {"healthy": healthy[t], "port": b["port"]} for t, b in router.tiers.items()},
                })
            elif path == "/v1/models":
                if self.authorized():
                    ids = ["auto", *router.tiers]
                    self.send_json(200, {"object": "list", "data": [
                        {"id": i, "object": "model", "owned_by": "locus"} for i in ids]})
            elif path == "/router/stats":
                if self.authorized():
                    self.send_json(200, router.stats())
            else:
                self.error(404, "not found", "not_found_error")

        # -- POST ------------------------------------------------------------
        def do_POST(self):
            if self.path.split("?", 1)[0] != "/v1/chat/completions":
                self.error(404, "not found", "not_found_error")
                return
            if not self.authorized():
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self.error(411, "Content-Length required")
                return
            if length < 0 or length > MAX_BODY_BYTES:
                self.error(413, "body too large")
                return
            try:
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("body must be a JSON object")
            except ValueError as e:
                self.error(400, f"invalid JSON body: {e}")
                return
            self.chat(body)

        def chat(self, body):
            t_start = time.monotonic()
            ts = time.time()
            requested = body.get("model") or router.default
            if not isinstance(requested, str) or (requested != "auto" and requested not in router.tiers):
                self.error(400, f"model must be one of auto, {', '.join(router.tiers)}")
                return
            try:
                policy = parse_policy(body["router_policy"]) if body.get("router_policy") else router.policy
            except (ValueError, TypeError) as e:
                self.error(400, f"router_policy: {e}")
                return
            judge = body.get("router_judge") or router.judge
            if judge not in ("none", "fast"):
                self.error(400, "router_judge must be none or fast")
                return

            sc, features = score(body)
            need = prompt_tokens(body) + max_tokens_of(body)
            features["need_tokens"] = need
            judge_ms = None
            if (requested == "auto" and needs_score(policy) and judge == "fast"
                    and "fast" in router.tiers and router.healthy.get("fast")):
                verdict, judge_ms = router.ask_judge()(body)
                features["judge"] = verdict
                features["judge_ms"] = round(judge_ms, 1)
                if verdict is not None:
                    sc = round(JUDGE_WEIGHT * verdict + (1 - JUDGE_WEIGHT) * sc, 3)

            with router.lock:
                if requested == "auto":
                    tier, reason = choose(policy, sc, need, router.tiers, router.healthy, router.inflight)
                else:
                    tier, reason = (requested, "explicit") if router.healthy.get(requested) else (None, "unhealthy")
                router.decisions += 1
                if tier is not None:
                    router.inflight[tier] += 1
                    router.routed[tier] += 1
                    if reason == "spill":
                        router.spills += 1
                snapshot = dict(router.inflight)

            rec = {"ts": round(ts, 3), "policy": policy, "requested": requested, "tier": tier,
                   "score": sc, "reason": reason, "features": features, "inflight": snapshot,
                   "ttft_s": None, "latency_s": None, "status": None}
            if judge_ms is not None:
                rec["judge_ms"] = round(judge_ms, 1)
            tag = {"x-locus-score": f"{sc:.3f}", "x-locus-reason": reason}
            if tier is None:
                rec["status"] = 503
                router.write_log(rec)
                self.error(503, f"no healthy backend for {requested}", "unavailable_error", tag)
                return
            tag["x-locus-tier"] = tier
            try:
                status, ttft = self.forward(tier, body, tag, t_start)
                rec["status"], rec["ttft_s"] = status, ttft
                failed = status >= 400
            except ClientGone:
                rec["status"], failed = 499, False
                self.close_connection = True
            finally:
                with router.lock:
                    router.inflight[tier] -= 1
            if failed:
                with router.lock:
                    router.errors[tier] += 1
            rec["latency_s"] = round(time.monotonic() - t_start, 4)
            router.write_log(rec)

        def forward(self, tier, body, tag, t_start):
            """Stream the backend's answer through. Returns (status, ttft_s)."""
            fwd = {k: v for k, v in body.items() if k not in STRIP_FIELDS}
            data = json.dumps(fwd).encode()
            conn = http.client.HTTPConnection(router.backend_host, router.tiers[tier]["port"], timeout=UPSTREAM_TIMEOUT_S)
            try:
                try:
                    conn.request("POST", "/v1/chat/completions", body=data, headers={
                        "Content-Type": "application/json",
                        "Accept": self.headers.get("Accept", "*/*"),
                        "Authorization": f"Bearer {router.key}",
                    })
                    resp = conn.getresponse()
                except (OSError, http.client.HTTPException) as e:
                    if isinstance(e, ConnectionRefusedError):
                        router.mark_down(tier)
                    self.error(502, f"backend {tier} unreachable: {type(e).__name__}", "upstream_error", tag)
                    return 502, None

                self.send_response(resp.status)
                for k, v in resp.getheaders():
                    if k.lower() not in HOP_BY_HOP:
                        self.send_header(k, v)
                for k, v in tag.items():
                    self.send_header(k, v)
                length = resp.getheader("Content-Length")
                chunked = length is None
                if chunked:
                    self.send_header("Transfer-Encoding", "chunked")
                else:
                    self.send_header("Content-Length", length)
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()

                ttft = None
                while True:
                    try:
                        chunk = resp.read1(65536)
                    except (OSError, http.client.HTTPException):
                        # Backend died mid-stream: end our side; the client sees a cut stream.
                        self.close_connection = True
                        if chunked:
                            self.write(b"0\r\n\r\n")
                        return 502, ttft
                    if not chunk:
                        break
                    if ttft is None:
                        ttft = round(time.monotonic() - t_start, 4)
                    self.write(b"%x\r\n%s\r\n" % (len(chunk), chunk) if chunked else chunk)
                if chunked:
                    self.write(b"0\r\n\r\n")
                return resp.status, ttft
            finally:
                # Closing the socket is what makes llama-server stop generating for a gone client.
                conn.close()

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


def parse_backend(spec):
    """NAME=PORT:SLOTS:CTX_PER_SLOT -> (name, {"port", "slots", "ctx"})."""
    m = re.fullmatch(r"([a-z][a-z0-9_-]*)=(\d+):(\d+):(\d+)", spec.strip())
    if not m:
        raise argparse.ArgumentTypeError(f"backend must be NAME=PORT:SLOTS:CTX_PER_SLOT, got {spec!r}")
    name, port, slots, ctx = m.group(1), *map(int, m.group(2, 3, 4))
    if name not in TIERS:
        raise argparse.ArgumentTypeError(f"backend name must be one of {', '.join(TIERS)}")
    return name, {"port": port, "slots": max(1, slots), "ctx": ctx}


def build(args):
    backends = dict(args.backend)
    if len(backends) != len(args.backend):
        raise SystemExit("router: duplicate --backend name")
    if args.default != "auto" and args.default not in backends:
        raise SystemExit(f"router: --default {args.default} is not a backend")
    if args.judge == "fast" and "fast" not in backends:
        raise SystemExit("router: --judge fast needs a fast backend")
    with open(args.key_file) as f:
        key = f.read().strip()
    if not key:
        raise SystemExit("router: key file is empty")
    try:
        router = Router(backends, key, policy=args.policy, default=args.default, judge=args.judge,
                        log_path=args.log, health_interval=args.health_interval)
    except ValueError as e:
        raise SystemExit(f"router: {e}")
    return router


def main(argv=None):
    ap = argparse.ArgumentParser(description="locus tier router")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--key-file", required=True)
    ap.add_argument("--backend", type=parse_backend, action="append", required=True,
                    help="NAME=PORT:SLOTS:CTX_PER_SLOT, e.g. deep=8081:4:32768 (repeat)")
    ap.add_argument("--policy", default="difficulty+spill")
    ap.add_argument("--default", default="deep", help="tier for requests without model (deep|fast|auto)")
    ap.add_argument("--judge", default="none", choices=["none", "fast"])
    ap.add_argument("--log", help="JSONL decision log (appended)")
    ap.add_argument("--health-interval", type=float, default=HEALTH_INTERVAL_S, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    router = build(args)
    router.check_health()
    threading.Thread(target=router.health_loop, daemon=True).start()
    srv = Server((args.host, args.port), make_handler(router))
    print(f"router: listening on {args.host}:{args.port}, backends "
          + ", ".join(f"{t}=:{b['port']} ({b['slots']}x{b['ctx']})" for t, b in router.tiers.items())
          + f", policy {router.policy}, default {router.default}, judge {router.judge}", file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        router.stop.set()
        srv.server_close()


if __name__ == "__main__":
    main()
