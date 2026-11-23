#!/usr/bin/env python3
"""Closed-loop load generator for llama-server's OpenAI-compatible chat endpoint.

C simulated users each send ROUNDS requests back to back (the next one as soon
as the previous answer ends). Every request streams, so time to first token is
measured on the client. Generation length is fixed with ignore_eos, so runs are
comparable. Prints one JSON object (summary + per-request rows) to stdout.

Workloads:
  chat        short question, ~60 prompt tokens
  doc         the sample report (~2.2k tokens) + a question; each request gets a
              unique first line so no two requests share a cacheable prefix
  shared-doc  the same report for every user (the demo's one-click example),
              so prompt caching across users can help

Stdlib only: runs with the image's python3.
"""
import argparse
import http.client
import json
import statistics
import threading
import time
import uuid

QUESTIONS = [
    "Summarize the three biggest risks in this report in three bullets.",
    "Extract the key financial KPIs into a table.",
    "Draft a five-sentence note to the board about this quarter.",
    "Check the arithmetic: do the segment revenues add up to group revenue?",
]
CHAT = [
    "Explain in plain words what a mixture-of-experts language model is.",
    "Give me three tips for writing a clear project status update.",
    "What is the difference between revenue and profit? Keep it short.",
    "Write a polite email declining a meeting invitation.",
]


def build_messages(workload, report, user, i):
    if workload == "chat":
        return [{"role": "user", "content": CHAT[(user + i) % len(CHAT)]}]
    q = QUESTIONS[(user + i) % len(QUESTIONS)]
    if workload == "doc":
        head = f"Request {uuid.uuid4()}.\n"  # unique prefix: defeats cross-request prompt caching
    else:
        head = ""
    return [{"role": "user", "content": f"{head}<document>\n{report}\n</document>\n\n{q}"}]


def one_request(host, port, key, messages, max_tokens, timeout):
    body = json.dumps({
        "messages": messages,
        "stream": True,
        "max_tokens": max_tokens,
        "ignore_eos": True,  # fixed answer length, so runs compare
        "temperature": 0.7,
        "cache_prompt": True,
        "chat_template_kwargs": {"enable_thinking": False},
    })
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    t0 = time.monotonic()
    ttft = None
    timings = None
    out_chunks = 0
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("POST", "/v1/chat/completions", body, headers)
        resp = conn.getresponse()
        if resp.status != 200:
            return {"ok": False, "error": f"HTTP {resp.status}: {resp.read(300)!r}", "latency_s": time.monotonic() - t0}
        buf = b""
        while True:
            chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(4096)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line.startswith(b"data: "):
                    continue
                data = line[6:]
                if data == b"[DONE]":
                    continue
                try:
                    j = json.loads(data)
                except ValueError:
                    continue
                ch = (j.get("choices") or [{}])[0].get("delta") or {}
                if ttft is None and (ch.get("content") or ch.get("reasoning_content")):
                    ttft = time.monotonic() - t0
                if ch.get("content") or ch.get("reasoning_content"):
                    out_chunks += 1
                if j.get("timings"):
                    timings = j["timings"]
    except Exception as e:  # noqa: BLE001 - a failed request is a result, not a crash
        return {"ok": False, "error": repr(e), "latency_s": time.monotonic() - t0}
    finally:
        conn.close()
    lat = time.monotonic() - t0
    t = timings or {}
    return {
        "ok": True,
        "latency_s": round(lat, 3),
        "ttft_s": round(ttft, 3) if ttft is not None else None,
        "prompt_n": t.get("prompt_n"),
        "cache_n": t.get("cache_n"),
        "prompt_per_second": t.get("prompt_per_second"),
        "predicted_n": t.get("predicted_n", out_chunks),
        "predicted_per_second": t.get("predicted_per_second"),
    }


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = max(0, min(len(xs) - 1, round(p / 100 * (len(xs) - 1))))
    return xs[k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--key", default="")
    ap.add_argument("--workload", choices=["chat", "doc", "shared-doc"], required=True)
    ap.add_argument("--users", type=int, required=True)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--max-tokens", type=int, default=256)
    ap.add_argument("--report", required=True)
    ap.add_argument("--timeout", type=float, default=900)
    a = ap.parse_args()
    report = open(a.report, encoding="utf-8").read()

    rows = []
    lock = threading.Lock()

    def user(u):
        for i in range(a.rounds):
            r = one_request(a.host, a.port, a.key, build_messages(a.workload, report, u, i), a.max_tokens, a.timeout)
            r.update(user=u, round=i)
            with lock:
                rows.append(r)

    t0 = time.monotonic()
    threads = [threading.Thread(target=user, args=(u,)) for u in range(a.users)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.monotonic() - t0

    ok = [r for r in rows if r["ok"]]
    gen = sum(r.get("predicted_n") or 0 for r in ok)
    summary = {
        "workload": a.workload,
        "users": a.users,
        "rounds": a.rounds,
        "requests": len(rows),
        "failed": len(rows) - len(ok),
        "wall_s": round(wall, 2),
        "aggregate_gen_tps": round(gen / wall, 1) if wall else None,
        "per_user_gen_tps_mean": round(statistics.mean(r["predicted_per_second"] for r in ok if r.get("predicted_per_second")), 1) if ok else None,
        "ttft_mean_s": round(statistics.mean(r["ttft_s"] for r in ok if r.get("ttft_s") is not None), 2) if ok else None,
        "ttft_p95_s": pct([r["ttft_s"] for r in ok if r.get("ttft_s") is not None], 95),
        "latency_mean_s": round(statistics.mean(r["latency_s"] for r in ok), 2) if ok else None,
        "latency_p95_s": pct([r["latency_s"] for r in ok], 95),
        "cache_hit_tokens_mean": round(statistics.mean((r.get("cache_n") or 0) for r in ok), 0) if ok else None,
    }
    print(json.dumps({"summary": summary, "rows": rows}))


if __name__ == "__main__":
    main()
