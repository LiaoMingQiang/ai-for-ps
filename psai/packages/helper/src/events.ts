/**
 * WebSocket 事件中枢。
 * 插件靠它拿任务进度；断线时插件会退避重连并主动补拉一次列表，所以这里不做消息重放。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { PSAI_VERSION, PSAI_SCHEMA_VERSION } from '@psai/shared';
import type { HelperEvent } from '@psai/shared';
import type { PairingService } from './pairing.js';
import type { Logger } from './log.js';

export class EventHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  constructor(
    private readonly pairing: PairingService,
    private readonly log: Logger
  ) {}

  attach(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/v1/events') {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token');
      if (!this.pairing.verify(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => this.clients.delete(ws));
        this.send(ws, { type: 'hello', version: PSAI_VERSION, schemaVersion: PSAI_SCHEMA_VERSION });
      });
    });
  }

  private send(ws: WebSocket, ev: HelperEvent): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(ev));
    } catch (e) {
      this.log.debug('WS 发送失败', String(e));
    }
  }

  broadcast(ev: HelperEvent): void {
    for (const ws of this.clients) this.send(ws, ev);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
}
