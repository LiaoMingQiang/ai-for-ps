/**
 * 绑一个**不在 WHATWG 禁用端口表上**的端口。
 *
 * 为什么需要：undici（Node 的 fetch）和浏览器一样，拒绝连接一批约定俗成的
 * 危险端口（6667 是 IRC、6679、2049 是 NFS、5060 是 SIP……），连 TCP 都不去连，
 * 报的是一句 `bad port` 或者笼统的 `fetch failed`。
 *
 * 测试里的桩全部用 port 0 让系统分配，而这台机器的动态端口范围被调得很低，
 * 于是隔三差五就撞上一个。表现是整批用例一起红、重跑又好 —— 这个 flake
 * 前后犯了六次：
 *   前五次落在 Helper 上（已在 startHelper 里避让）
 *   第六次落在 ComfyUI 桩上：桩绑到 6679，Helper 连不上它，
 *     autowriteback 整个文件 28 条一起挂
 *
 * 所以避让不能只做在 Helper 一侧，凡是"别人要来连"的服务器都得做。
 *
 * 表按 WHATWG URL 规范的 bad port list 抄写，和 helper/src/index.ts 里那份一致。
 */

const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080
]);

export function isBadPort(port) {
  return BAD_PORTS.has(port);
}

/**
 * 和 `server.listen(port, host)` 一样，但 port 为 0 时会避开禁用端口。
 *
 * 撞上就关掉重来，最多 8 次 —— 禁用表一共几十个端口，连撞八次的概率
 * 低到可以忽略。指定了具体端口时原样照做：那是调用方的决定。
 */
export async function listenSafe(server, port = 0, host = '127.0.0.1') {
  for (let attempt = 0; ; attempt++) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const got = server.address()?.port;
    if (port !== 0 || !isBadPort(got) || attempt >= 7) return got;
    // 关掉再要一个。net/http 的 server 关掉之后可以重新 listen（和 Fastify 不同）
    await new Promise((r) => server.close(r));
  }
}
