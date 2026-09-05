/**
 * 一个**保证连不上**的本机地址。
 *
 * 之前的做法是"绑 0 号端口拿一个，然后关掉再用"。那是个竞态：
 * 关掉之后那个端口对整台机器就是空闲的，别的进程（包括并发跑着的
 * 其它测试套件、它们起的 Helper 和桩）随时可能绑上去。
 * 真赶上了，那条本该测"连不上"的用例会连到一个**别人的服务**上，
 * 拿到 404 或者一段莫名其妙的响应 —— 于是它要么假通过，
 * 要么以一种和真正原因毫无关系的方式失败。
 *
 * 现在改成：真的起一个服务器占住端口，但让它对每个连接
 * 立刻 destroy。端口在整个用例期间**始终被我们占着**，
 * 谁都抢不走；而客户端拿到的是一次干净的连接重置 ——
 * 那正是"连不上"要测的东西。
 *
 * 用完必须 stop()，否则端口一直占着。
 */

import { createServer } from 'node:net';
import { listenSafe } from '../../../tools/listen-safe.mjs';

export async function startDeadServer() {
  const sockets = new Set();
  const srv = createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    // 连上就掐断：客户端看到的是 ECONNRESET，和"没人监听"一样是网络级失败，
    // 但端口自始至终在我们手里，不会被别人抢去变成一个能正常应答的服务。
    sock.destroy();
    sockets.delete(sock);
  });
  srv.on('error', () => {});
  // 这个桩要的是"连上就被掐断"，不是"根本连不上" —— 绑到禁用端口的话
  // undici 压根不会去连，那条用例测的就不是它想测的东西了
  const port = await listenSafe(srv, 0, '127.0.0.1');
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((r) => srv.close(r));
    }
  };
}
