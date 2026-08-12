#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""run-all: 一键全量测试 — 自启动 ComfyUI stub, 跑全部测试套件, 关闭 stub (PHASE 21)
用法: python scripts/run-all.py  (或 npm test -> 见 helper/package.json)"""
import os
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, "helper")
STUB_PORT = 18189

def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False

def run(name, cmd, cwd, timeout=420):
    print("\n=== %s ===" % name)
    t0 = time.time()
    r = subprocess.run(cmd, cwd=cwd, timeout=timeout)
    dt = time.time() - t0
    print("--- %s: exit=%d (%.0fs)" % (name, r.returncode, dt))
    return r.returncode

def main():
    stub = None
    if not port_open(STUB_PORT):
        print("[run-all] 启动 ComfyUI stub @%d" % STUB_PORT)
        stub = subprocess.Popen([sys.executable, os.path.join(ROOT, "test", "comfy_stub.py"), "--port", str(STUB_PORT)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(40):
            if port_open(STUB_PORT):
                break
            time.sleep(0.25)
        if not port_open(STUB_PORT):
            print("[run-all] FAIL: stub 未启动")
            return 1
    else:
        print("[run-all] stub 已在运行 @%d (复用)" % STUB_PORT)

    tests = [
        ("helper-smoke",        ["node", "test/helper-smoke.mjs", "33157"], HELPER),
        ("comfyui.integration", ["node", "test/comfyui.integration.mjs", "18189"], HELPER),
        ("openai.integration",  ["node", "test/openai.integration.mjs"], HELPER),
        ("workflow.integration",["node", "test/workflow.integration.mjs"], HELPER),
        ("binding.integration", ["node", "test/binding.integration.mjs"], HELPER),
        ("job-engine.integration", ["node", "test/job-engine.integration.mjs"], HELPER),
        ("cloud.integration",   ["node", "test/cloud.integration.mjs"], HELPER),
        ("uxp-jobs-helper",     ["node", "test/uxp-jobs-helper.test.mjs"], ROOT),
    ]
    failed = []
    for name, cmd, cwd in tests:
        rc = run(name, cmd, cwd)
        if rc != 0:
            failed.append(name)

    if stub:
        stub.kill()
        print("[run-all] stub 已关闭")

    if failed:
        print("\n[run-all] FAILED: %s" % ", ".join(failed))
        return 1
    print("\n[run-all] ALL PASS (%d suites)" % len(tests))
    return 0

if __name__ == "__main__":
    sys.exit(main())
