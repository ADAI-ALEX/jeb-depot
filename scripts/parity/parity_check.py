"""Parity check: the Rust port (jeb-core / jebd) against the official JEB server (szybkie-ai/jeb, Python).

Both sit in front of the SAME llama-server, so any difference comes from the protocol layer (templating,
tokenization, label handling, combination), not from the model. Checks:

  1. tokenizer ids: Python `tokenizers` (what the official server uses) vs Rust `tokenizers` on a corpus
  2. rendered prompts: the official server's debug prompts vs ours, byte for byte
  3. usage accounting: input/output tokens
  4. answers: per-presentation label log-probabilities and final distributions, and primed vs scratch scheduling

Run inside the official repo's environment:
  uv run --project <jeb-repo> python scripts/parity/parity_check.py --llama-bin ... --model ... --tokenizer-dir ... \
      --jebd target/debug/jebd --jeb-repo <jeb-repo> --out docs/benchmarks/parity.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import socket
import statistics
import subprocess
import sys
import time

import httpx
from jeb.prompt import HFTokenizer


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 180.0) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if httpx.get(url, timeout=2).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    raise RuntimeError(f"{url} not ready after {timeout} s")


class Jebd:
    def __init__(self, cmd: list[str]):
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.n = 0

    def call(self, op: str, **kw):
        self.n += 1
        self.p.stdin.write(json.dumps({"id": self.n, "op": op, **kw}) + "\n")
        self.p.stdin.flush()
        r = json.loads(self.p.stdout.readline())
        if not r["ok"]:
            raise RuntimeError(r["error"])
        return r["result"]

    def close(self):
        self.p.terminate()


def corpus() -> list[str]:
    rng = random.Random(7)
    base = [
        "Hello world", "  leading spaces", "trailing   ", "tabs\tand\nnewlines\n\n\n", "ROBOT: tile (7,4), facing east, battery 54%",
        "Zażółć gęślą jaźń — polskie znaki", "emoji 🤖📦🔋", "<|im_start|>user\nhi<|im_end|>\n<think>\n\n</think>\n\n", "A", "B", "Yes", "No",
        "numbers 1234567890 3.14159 -42 1e-05", "JSON {\"a\": [1, 2, {\"b\": null}]}", "     \n   \n", "'s 't 're 've 'm 'll 'd", "CamelCaseWords and snake_case_words",
        "https://huggingface.co/szybkie-ai/jeb-4b", "中文字符和日本語のテキスト", "ALL CAPS SHOUTING!!!", "x" * 300,
    ]
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n\t.,;:!?()[]{}'\"-_/\\|@#$%^&*+=<>~`ąęłńóśźżé—→←↑↓🙂"
    for _ in range(200):
        base.append("".join(rng.choice(alphabet) for _ in range(rng.randint(1, 120))))
    return base


def requests() -> list[dict]:
    readme = {
        "state": "I was charged twice for order A-104. Please refund the duplicate.",
        "questions": {
            "refund": {"type": "noul", "instructions": "Does the customer ask for a refund?"},
            "team": {"type": "choice", "instructions": "Which team should handle this?", "criteria": {"billing": "Payments, refunds", "technical": "Bugs, outages"}},
            "anger": {"type": "score", "instructions": "How angry is the customer?", "criteria": ["Calm", "Annoyed", "Furious"]},
        },
    }
    robot = {
        "state": "ROBOT: tile (7,4), facing east, battery 54%, carrying package B (HIGH) for dock 2\nTARGET: dock 2, 7 steps on the primary route\n"
        "FORWARD: open floor, on route, 6 steps from there\nLEFT: shelf, blocked\nRIGHT: oil spill (slippery), 8 steps from there\nREVERSE: open floor, 8 steps from there\n"
        "TRAFFIC: forklift F1 2 tiles ahead, coming toward the robot; it enters the FORWARD tile next tick\nBATTERY: enough for about 108 steps; nearest charger 9 steps away\n"
        "MISSION: 3 of 8 delivered, score 340, 212 ticks left",
        "questions": {
            "move": {"type": "choice", "instructions": "Which way should the robot move this tick?", "criteria": {"LEFT": None, "FORWARD": None, "RIGHT": None, "REVERSE": None}},
            "reroute": {"type": "noul", "instructions": "The planned route is obstructed by forklift F1; a clear detour is 3 steps longer. Should the robot take the detour?",
                        "criteria": {"true": "Take the detour", "false": "Keep the planned route"}},
            "risk": {"type": "score", "instructions": "How risky is the robot's immediate situation?", "criteria": ["LOW", "MEDIUM", "HIGH"]},
            "target": {"type": "choice", "instructions": "Which objective should the robot pursue next?",
                       "criteria": {"PACKAGE A": "priority NORMAL, 9 steps", "PACKAGE C": "priority URGENT, 15 steps", "CHARGE": "charger 9 steps, battery 54%"}},
        },
    }
    json_state = {
        "state": {"robot": {"tile": [7, 4], "battery": 0.54, "facing": "east", "notes": "zażółć — ok", "empty": {}, "list": []},
                  "traffic": [{"id": "F1", "distance": 2, "eta": 1.5e-05}, {"id": "F2", "distance": 11, "eta": 12.0}], "flag": True, "none": None},
        "questions": {
            "go": {"type": "noul", "instructions": {"ask": "Is it safe to move forward?", "consider": ["traffic", "robot.battery"]}},
            "lvl": {"type": "score", "instructions": "Battery level?", "criteria": ["empty", "low", "half", "high", {"label": "full", "min": 0.95}]},
            "pick": {"type": "choice", "instructions": "Pick a lane", "criteria": {"lane 1": {"width": 2, "clear": True}, "lane 2": "", "lane 3": None, "lane 4": ["busy", 3]}},
        },
    }
    out = []
    for base in (readme, robot, json_state):
        for perms in (1, 2, 3, 4):
            out.append({**base, "model": "jeb-latest", "options": {"permutations": perms, "debug": True}})
    return out


def tv(a: dict, b: dict) -> float:
    return 0.5 * sum(abs(a[k] - b[k]) for k in a)


def answer_dist(ans: dict) -> dict:
    if ans["type"] == "noul":
        return {"yes": ans["noul"], "no": 1 - ans["noul"]}
    return ans["probabilities"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--llama-bin", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--tokenizer-dir", required=True)
    ap.add_argument("--jebd", required=True)
    ap.add_argument("--jeb-repo", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    lport, jport = free_port(), free_port()
    llama = subprocess.Popen([a.llama_bin, "-m", a.model, "--host", "127.0.0.1", "--port", str(lport), "-ngl", "999", "-c", "4096", "-np", "1", "--cache-ram", "0", "--no-webui"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    official = None
    jebd = None
    try:
        wait_http(f"http://127.0.0.1:{lport}/health")
        env = {**os.environ, "HF_HUB_OFFLINE": "1"}
        official = subprocess.Popen(["uv", "run", "--project", a.jeb_repo, "jeb", "serve", "--engine", "llama-server", "--engine-url", f"http://127.0.0.1:{lport}",
                                     "--tokenizer", a.tokenizer_dir, "--model-id", "jeb-4b", "--port", str(jport)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        wait_http(f"http://127.0.0.1:{jport}/healthz")
        jebd = Jebd([a.jebd, "attach", "--engine-url", f"http://127.0.0.1:{lport}", "--tokenizer", os.path.join(a.tokenizer_dir, "tokenizer.json")])
        report: dict = {"model": os.path.basename(a.model)}

        # 1. tokenizer parity
        py_tok = HFTokenizer.load(a.tokenizer_dir)
        texts = corpus()
        mismatches = [t for t in texts if py_tok.encode(t) != jebd.call("tokenize", text=t)]
        report["tokenizer"] = {"strings": len(texts), "mismatches": len(mismatches), "examples": mismatches[:3]}
        print(f"tokenizer: {len(texts) - len(mismatches)}/{len(texts)} strings tokenize identically")

        # 2-4. request parity
        client = httpx.Client(timeout=300)
        rows = []
        for i, req in enumerate(requests()):
            off = client.post(f"http://127.0.0.1:{jport}/v1/systemone", json=req).json()
            prim = jebd.call("decide", body=req, scheduling="primed")
            scr = jebd.call("decide", body=req, scheduling="scratch")
            row = {"request": i, "permutations": req["options"]["permutations"], "questions": {}}
            row["usage_equal"] = off["usage"] == prim["usage"] == scr["usage"]
            for qid in req["questions"]:
                od, pd = off["debug"][qid], prim["debug"][qid]
                prompts_equal = od["prompts"] == pd["prompts"]
                lp_diff = max(abs(x - y) for po, pp in zip(od["permutations"], pd["permutations"]) for x, y in zip(po["logprobs"], pp["logprobs"]))
                o, p, s = answer_dist(off["answers"][qid]), answer_dist(prim["answers"][qid]), answer_dist(scr["answers"][qid])
                top = lambda d: max(d, key=d.get)
                row["questions"][qid] = {
                    "prompts_equal": prompts_equal, "presentations": len(od["permutations"]), "max_label_logprob_diff": lp_diff,
                    "tv_official_vs_primed": tv(o, p), "tv_official_vs_scratch": tv(o, s), "tv_primed_vs_scratch": tv(p, s),
                    "top1_equal": top(o) == top(p) == top(s), "official": o, "primed": p,
                }
            rows.append(row)
            q = row["questions"]
            print(f"req {i:2d} perms={row['permutations']} usage_equal={row['usage_equal']} prompts_equal={all(v['prompts_equal'] for v in q.values())} "
                  f"max_tv={max(v['tv_official_vs_primed'] for v in q.values()):.4f} top1_equal={all(v['top1_equal'] for v in q.values())}")
        qs = [v for r in rows for v in r["questions"].values()]
        report["requests"] = rows
        report["summary"] = {
            "requests": len(rows), "questions": len(qs),
            "all_prompts_identical": all(v["prompts_equal"] for v in qs),
            "all_usage_identical": all(r["usage_equal"] for r in rows),
            "top1_agreement": f"{sum(v['top1_equal'] for v in qs)}/{len(qs)}",
            "tv_official_vs_primed_mean": statistics.fmean(v["tv_official_vs_primed"] for v in qs),
            "tv_official_vs_primed_max": max(v["tv_official_vs_primed"] for v in qs),
            "tv_primed_vs_scratch_max": max(v["tv_primed_vs_scratch"] for v in qs),
            "max_label_logprob_diff": max(v["max_label_logprob_diff"] for v in qs),
            "tokenizer_mismatches": len(mismatches),
        }
        print(json.dumps(report["summary"], indent=2))
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        json.dump(report, open(a.out, "w"), indent=1)
        ok = (report["summary"]["all_prompts_identical"] and report["summary"]["all_usage_identical"] and not mismatches
              and report["summary"]["tv_official_vs_primed_max"] < 0.01)
        print("PARITY", "PASS" if ok else "FAIL")
        sys.exit(0 if ok else 1)
    finally:
        if jebd:
            jebd.close()
        if official:
            official.terminate()
        llama.terminate()


if __name__ == "__main__":
    main()
