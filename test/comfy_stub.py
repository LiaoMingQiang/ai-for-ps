#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ComfyUI 桩服务器 —— 用于 e2e 测试真实管线（无外部依赖，仅 aiohttp）。
实现 /system_stats /object_info /prompt /upload/image /history /view /interrupt。
生成真实可解码的 PNG（纯 zlib 构造）。默认端口 18188，可用 --port 覆盖。
带 CORS 头，模拟真实 ComfyUI 以 --enable-cors-headers 启动。"""
import asyncio
import json
import struct
import zlib
import sys
from aiohttp import web

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 18188
VERSION = "0.3.40-stub"

uploaded = {}          # name -> bytes
generated = {}         # filename -> bytes
history = {}           # prompt_id -> history entry
pending = {}           # prompt_id -> asyncio task
seq = 0

CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"}


def cors(resp):
    resp.headers.update(CORS)
    return resp


def make_png(w=320, h=240):
    """构造一张真实 RGB PNG（红蓝渐变），返回字节。"""
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter: none
        for x in range(w):
            raw += bytes((x % 256, y % 256, (x + y) % 256))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


async def handle_options(_req):
    return web.Response(status=204, headers=CORS)


async def handle_stats(_req):
    return cors(web.json_response({
        "system": {"comfyui_version": VERSION},
        "devices": [{"name": "Stub-Test-GPU", "vram_total": 8 * 1024 ** 3, "vram_free": 6 * 1024 ** 3}]
    }))


def node(name, required):
    return {"input": {"required": required, "optional": {}}, "output": ["IMAGE"], "output_name": ["IMAGE"],
            "name": name, "display_name": name, "description": "stub", "category": "stub"}


async def handle_object_info(_req):
    return cors(web.json_response({
        "CheckpointLoaderSimple": node("CheckpointLoaderSimple", {
            "ckpt_name": [["stub-flux1-dev.safetensors", "stub-sdxl.safetensors", "stub-realistic-v12.safetensors"], {}]}),
        "CLIPTextEncode": node("CLIPTextEncode", {"text": ["STRING", {"multiline": True}], "clip": ["CLIP"]}),
        "KSampler": node("KSampler", {
            "sampler_name": [["euler"], ["dpmpp_2m"], ["dpmpp_sde"]],
            "scheduler": [["normal"], ["karras"], ["simple"]]}),
        "EmptyLatentImage": node("EmptyLatentImage", {"width": ["INT", {}], "height": ["INT", {}], "batch_size": ["INT", {}]}),
        "VAEEncode": node("VAEEncode", {"pixels": ["IMAGE"], "vae": ["VAE"]}),
        "VAEDecode": node("VAEDecode", {"samples": ["LATENT"], "vae": ["VAE"]}),
        "LoadImage": node("LoadImage", {"image": ["STRING"], "upload": ["STRING"]}),
        "SaveImage": node("SaveImage", {"images": ["IMAGE"], "filename_prefix": ["STRING", {}]})
    }))


KNOWN = {"CheckpointLoaderSimple", "CLIPTextEncode", "KSampler", "EmptyLatentImage",
         "VAEEncode", "VAEDecode", "LoadImage", "SaveImage"}

# --- 队列/取消/WS 状态 (PHASE 6 integration test 支持) ---
queue_running = []   # [[number, prompt_id, wf]]
queue_pending = []   # [[number, prompt_id, wf]]
interrupted = []     # 记录 interrupt 调用
ws_clients = set()
ws_delete_log = []   # 记录 WS delete 消息收到的 prompt_id
exec_sleep = 2.5     # 默认执行时长


async def finish_prompt(prompt_id, wf, sleep_s=None):
    """模拟执行: sleep_s 后产出 1 张图, 写入 history; 期间发 WS progress 消息。"""
    global seq
    s = sleep_s if sleep_s is not None else exec_sleep
    steps = 20
    for i in range(1, steps + 1):
        await asyncio.sleep(s / steps)
        # 官方 progress 结构: { type:"progress", data:{ value, max, prompt_id, node } }
        for c in list(ws_clients):
            try:
                await c.send_json({"type": "progress", "data": {"value": i, "max": steps,
                                                                 "prompt_id": prompt_id, "node": 10}})
            except Exception:
                pass
        if prompt_id in interrupted:
            history[prompt_id] = {"prompt": wf, "status": {"status_str": "error", "completed": False,
                                                           "messages": [["execution_interrupted", {}]]}, "outputs": {}}
            queue_running.clear()
            pending.pop(prompt_id, None)
            return
    seq += 1
    fn = "aiforps_%s_%04d_.png" % (prompt_id, seq)
    generated[fn] = make_png()
    pending.pop(prompt_id, None)
    queue_running.clear()
    images = [{"filename": fn, "subfolder": "", "type": "output"}]
    last_node = [nid for nid, n in wf.items() if n.get("class_type") == "SaveImage"]
    outputs = {last_node[0]: {"images": images}} if last_node else {}
    history[prompt_id] = {"prompt": wf, "status": {"status_str": "success", "completed": True,
                                                   "messages": [["execution_success", {}]]}, "outputs": outputs}
    for c in list(ws_clients):
        try:
            await c.send_json({"type": "executed", "data": {"node": 99, "prompt_id": prompt_id,
                                                            "output": {"images": images}}})
        except Exception:
            pass


async def handle_prompt(req):
    body = await req.json()
    wf = body.get("prompt", {})
    errs = {}
    for nid, n in wf.items():
        ct = n.get("class_type")
        if ct not in KNOWN:
            errs[nid] = {"errors": [{"message": "Unknown node type: %s" % ct, "details": "", "extra_info": {}}]}
    if errs:
        return cors(web.json_response({"error": "prompt", "node_errors": errs}, status=400))
    global seq
    seq += 1
    pid = "stub-%d-%d" % (seq, int(asyncio.get_event_loop().time() * 1000))
    if queue_running:
        queue_pending.append([seq, pid, wf])
    else:
        queue_running.append([seq, pid, wf])
        pending[pid] = asyncio.ensure_future(finish_prompt(pid, wf))
    return cors(web.json_response({"prompt_id": pid, "number": seq, "node_errors": {}}))


async def handle_queue(_req):
    return cors(web.json_response({"queue_running": queue_running, "queue_pending": queue_pending}))


async def handle_interrupt(_req):
    if queue_running:
        interrupted.append(queue_running[0][1])   # 记录被 interrupt 的 prompt_id
    return cors(web.json_response({"ok": True}))


async def handle_ws(_req):
    ws = web.WebSocketResponse()
    await ws.prepare(_req)
    ws_clients.add(ws)
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    m = json.loads(msg.data)
                    if "delete" in m:
                        ids = m["delete"]
                        ws_delete_log.extend(ids)
                        for item in list(queue_pending):
                            if item[1] in ids:
                                queue_pending.remove(item)
                except Exception:
                    pass
    finally:
        ws_clients.discard(ws)
    return ws


async def handle_upload(req):
    reader = await req.multipart()
    name = None
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "image":
            name = part.filename
            uploaded[name] = await part.read()
    return cors(web.json_response({"name": name, "subfolder": "", "type": "input"}))


async def handle_history(req):
    pid = req.match_info.get("id")
    if not pid:
        return cors(web.json_response(history))
    h = history.get(pid)
    return cors(web.json_response({pid: h} if h else {}))


async def handle_view(req):
    q = req.query
    fn = q.get("filename", "")
    typ = q.get("type", "output")
    if fn in generated:
        return cors(web.Response(body=generated[fn], content_type="image/png"))
    if typ == "input" and fn in uploaded:
        return cors(web.Response(body=uploaded[fn], content_type="image/png"))
    return cors(web.Response(status=404))


app = web.Application()
app.router.add_options("/{tail:.*}", handle_options)
app.router.add_get("/system_stats", handle_stats)
app.router.add_get("/object_info", handle_object_info)
app.router.add_post("/prompt", handle_prompt)
app.router.add_post("/upload/image", handle_upload)
app.router.add_get("/history", handle_history)
app.router.add_get("/history/{id}", handle_history)
app.router.add_get("/queue", handle_queue)
app.router.add_get("/view", handle_view)
app.router.add_post("/interrupt", handle_interrupt)
app.router.add_get("/ws", handle_ws)

if __name__ == "__main__":
    print("comfy_stub listening on http://127.0.0.1:%d (%s)" % (PORT, VERSION), flush=True)
    web.run_app(app, port=PORT, print=None)