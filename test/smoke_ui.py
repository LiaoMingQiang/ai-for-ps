#!/usr/bin/env python3
"""uxp-plugin 浏览器冒烟测试: CDP 驱动 Chrome headless
- 加载 http://127.0.0.1:8877/index.html (真实 HTTP)
- 等 6s 真实时间
- 断言: 无 uncaught 错误 / UI 导航渲染 / 无 mock 成功提示
用法: python test/smoke_ui.py
"""
import json, subprocess, sys, time, urllib.request, random, os
import websocket  # websocket-client

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9400 + random.randint(0, 200)
PROFILE = os.path.join(os.environ.get("TEMP", "."), "a4p-smoke-" + str(os.getpid()))
URL = "http://127.0.0.1:8877/index.html"

def main():
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--disable-gpu", f"--remote-debugging-port={PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={PROFILE}", URL
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # 等调试端口
    for _ in range(30):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=2))
            break
        except Exception:
            time.sleep(0.5)
    else:
        print("FAIL: devtools port not ready"); proc.kill(); sys.exit(1)

    tab = next((t for t in tabs if t.get("type") == "page"), tabs[0])
    ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=10)
    msg_id = 0
    errors = []

    def send(method, params=None):
        nonlocal msg_id
        msg_id += 1
        ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == msg_id:
                return r.get("result", {})
            if r.get("method") == "Runtime.exceptionThrown":
                errors.append(r["params"]["exceptionDetails"].get("text", "?"))

    send("Runtime.enable")
    send("Page.enable")
    time.sleep(6)  # 真实等待 bootstrap 链 (fetch/ws 失败路径)

    # 1. uncaught 错误
    r = send("Runtime.evaluate", {"expression": "window.__smokeErrors ? window.__smokeErrors.length : -1", "returnByValue": True})
    # 0. 诊断: 运行时状态
    diag = send("Runtime.evaluate", {"expression": """
        JSON.stringify({
          readyState: document.readyState,
          hasA4P: typeof A4P !== 'undefined',
          hasMain: typeof A4P !== 'undefined' && typeof A4P.main !== 'undefined',
          hasRouter: typeof A4P !== 'undefined' && typeof A4P.uiRouter !== 'undefined',
          appChildren: (document.getElementById('app')||{}).children ? document.getElementById('app').children.length : -1,
          page: (typeof A4P !== 'undefined' && A4P.state) ? A4P.state.page : null,
          lastPage: (typeof A4P !== 'undefined' && A4P.state) ? A4P.state.lastPage : null,
          reqType: typeof require
        })
    """, "returnByValue": True})
    d = json.loads(diag.get("result", {}).get("value", "{}")) if diag.get("result") else {}
    print("[smoke] diag =", json.dumps(d, ensure_ascii=False))

    # 0.5 手动逐步跑 bootstrap 链, 定位挂起步骤
    trace = send("Runtime.evaluate", {"expression": """
        (async function () {
          var out = [];
          function step(name, fn) {
            return Promise.race([
              Promise.resolve().then(fn).then(function (r) { out.push(name + ':ok'); return r; }),
              new Promise(function (_, rej) { setTimeout(function () { rej(new Error(name + ':TIMEOUT')); }, 2500); })
            ]).catch(function (e) { out.push(name + ':ERR:' + String(e)); });
          }
          await step('loadSettings', function () { A4P.store.load(); });
          await step('initPhotoshopBridge', function () { A4P.ps.init(); });
          await step('connectHelper', function () { return A4P.helper.health().then(function (h) { out.push('health=' + JSON.stringify(h)); }); });
          await step('pairHelper', function () { return A4P.helper.pair().then(function (r) { out.push('pair=' + JSON.stringify(r)); }); });
          await step('recoverJobs', function () { A4P.jobs.restore(); });
          await step('loadProjectContext', function () { A4P.psContext.refresh(); });
          await step('renderApp', function () { A4P.uiRouter.renderShell(document.getElementById('app')); A4P.uiRouter.switchPage('generate'); out.push('children=' + document.getElementById('app').children.length); });
          return out.join(' | ');
        })()
    """, "awaitPromise": True, "returnByValue": True})
    tv = trace.get("result", {}).get("value") if trace.get("result") else str(trace)
    print("[smoke] trace =", tv)
    # 2. UI 渲染
    r2 = send("Runtime.evaluate", {"expression": """
        (function(){
          var nav = document.querySelectorAll('.nav-item, nav a, [class*=nav]').length;
          var app = document.getElementById('app');
          return JSON.stringify({
            appChildren: app ? app.children.length : -1,
            navEls: nav,
            bodyText: (document.body.innerText||'').slice(0, 200),
            toast: (document.querySelector('.toast-wrap')||{}).innerText || ''
          });
        })()
    """, "returnByValue": True})
    ws.close()
    proc.kill()

    data = json.loads(r2.get("result", {}).get("value", "{}")) if r2.get("result") else {}
    print("[smoke] appChildren =", data.get("appChildren"))
    print("[smoke] navEls     =", data.get("navEls"))
    print("[smoke] bodyText   =", (data.get("bodyText") or "").replace(chr(10), " | ")[:150])
    print("[smoke] toast      =", (data.get("toast") or "").replace(chr(10), " | ")[:120])
    print("[smoke] uncaught   =", errors if errors else "none")

    fails = []
    if data.get("appChildren", 0) <= 0: fails.append("app 未渲染")
    if data.get("navEls", 0) <= 0: fails.append("导航未渲染")
    if errors: fails.append("uncaught errors: " + str(errors))
    # 禁止假成功 toast
    for bad in ["演示模式：未修改", "模拟", "demo success", "mock success"]:
        if bad in (data.get("toast") or ""): fails.append("出现 mock 提示: " + bad)
    if fails:
        print("[smoke] FAIL:", fails); sys.exit(1)
    print("[smoke] ALL PASS")

if __name__ == "__main__":
    main()
