/**
 * 最小 ZIP 写入器（deflate）。
 *
 * 为什么不用 PowerShell 的 Compress-Archive：Windows PowerShell 5.1 写出来的条目名
 * 用的是反斜杠（`dist\main.js`），而 ZIP 规范要求正斜杠。Adobe 的 .ccx 装载器按规范
 * 解析，反斜杠路径可能直接被判为无效包 —— 这种错到用户手里才会暴露。
 * 自己写就能完全控制条目名。
 */

import { deflateRawSync, crc32 } from 'node:zlib';
import { readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Node 22.15+ 才有 zlib.crc32；没有就用自带实现。 */
let CRC_TABLE = null;
function crc32Fallback(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function checksum(buf) {
  return typeof crc32 === 'function' ? crc32(buf) >>> 0 : crc32Fallback(buf);
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** 收集目录下所有文件，条目名一律用正斜杠。 */
export function collectFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push({ abs, name: relative(rootDir, abs).split(sep).join('/') });
    }
  };
  walk(rootDir);
  return out;
}

/**
 * 把一批文件写成 zip。
 * @param {string} outPath
 * @param {Array<{abs:string,name:string}>} files
 */
export function writeZip(outPath, files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const data = readFileSync(f.abs);
    const crc = checksum(data);
    const compressed = deflateRawSync(data, { level: 9 });
    // 压不小就存原始，避免反而变大
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const nameBuf = Buffer.from(f.name, 'utf8');
    const { time, date } = dosDateTime(statSync(f.abs).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 名称
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    // JS 的位运算是 32 位有符号的，0o100644 << 16 会溢出成负数，必须 >>> 0 转回无符号
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: 普通文件 0644
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  writeFileSync(outPath, Buffer.concat([...locals, centralBuf, end]));
  return { entries: files.length, bytes: statSync(outPath).size };
}

/** 读回条目名，用来校验产出的包。 */
export function listZip(zipPath) {
  const buf = readFileSync(zipPath);
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('中央目录条目签名不对');
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    names.push(buf.toString('utf8', pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
