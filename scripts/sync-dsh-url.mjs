// sync-dsh-url.mjs —— 启动前把 config.json 的 dsh.baseUrl 同步到 DSH 当前实际端口。
//
// 为什么需要：DSH 桌面版每次启动随机分配 Web 端口（实测 40891 → 5714 → 26081），
// config.json 写死 baseUrl 会在重启后全部连不上，而桥接本身没有任何端口发现逻辑。
// 本脚本是 qq-bridge 的**本地补充**（上游未提供），由 start-bridge.cmd 在启动前调用。
//
// 探测顺序（取第一个通过 DSH 特征校验的）：
//   1. 环境变量 DSH_WEB_URL（从 DSH 内置终端启动时自动带）
//   2. config.json 里的现有 baseUrl
//   3. TCP 全扫 127.0.0.1:1024-65535（本地 RST 毫秒级，约 7 秒），
//      对开放端口逐个用 DSH 的 RPC 信封特征校验
// 全部失败时保留原配置并返回非零，让调用方决定是否继续启动。
//
// 用法：
//   node scripts/sync-dsh-url.mjs           探测并打印，不写文件
//   node scripts/sync-dsh-url.mjs --write   探测并写回 config.json
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'config.json');
const WRITE = process.argv.includes('--write');

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const current = cfg.dsh?.baseUrl ?? '';

/** DSH web 的 /api/session/list 未授权时返回 401/404，且响应体是 DSH 的 RPC 信封。 */
async function isDshWeb(base) {
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/api/session/list', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'session/list', payload: { args: {} } }),
      signal: AbortSignal.timeout(1500),
    });
    if (r.status !== 401 && r.status !== 404) return false;
    const t = await r.text();
    // 实测三种 401 的正文完全不同（这是区分它们的可靠依据）：
    //   DSH 56735      -> 纯文本 "unauthorized"
    //   SnowLuma 3000  -> {"status":"failed","retcode":1401,...,"wording":"unauthorized"}
    //   桥接控制台 3100 -> {"ok":false,"error":"未授权：请提供控制台访问令牌"}
    // 先排除后两者，再认 DSH：纯 authorized 文本或 RPC 信封。
    if (/retcode|未授权|"ok"\s*:\s*false/.test(t)) return false;
    return t.replace(/^"|"$/g, '').trim() === 'unauthorized'
      || /"type"\s*:\s*"server-response"/.test(t);
  } catch { return false; }
}

const candidates = [];
if (process.env.DSH_WEB_URL) candidates.push(['env DSH_WEB_URL', process.env.DSH_WEB_URL]);
if (current) candidates.push(['config.json 现有值', current]);

let found = null;
const seen = new Set([current]);
for (const [how, base] of candidates) {
  process.stdout.write('[sync-dsh-url] 尝试验证 ' + base + '（' + how + '）… ');
  if (await isDshWeb(base)) { found = { how, base }; console.log('是'); break; }
  console.log('否');
}

if (!found) {
  // TCP 全扫回环端口，再逐个做 HTTP 特征校验
  console.log('[sync-dsh-url] 常规来源未命中，开始 TCP 扫描 127.0.0.1:1024-65535（约 7 秒）…');
  const t0 = Date.now();
  const open = [];
  const CONC = 600;
  let port = 1024;
  const tryPort = (p) => new Promise((res) => {
    const s = net.connect(p, '127.0.0.1');
    s.setTimeout(300);
    s.on('connect', () => { open.push(p); s.destroy(); res(); });
    s.on('timeout', () => { s.destroy(); res(); });
    s.on('error', () => { s.destroy(); res(); });
  });
  while (port <= 65535) {
    const batch = [];
    for (let i = 0; i < CONC && port <= 65535; i++, port++) batch.push(tryPort(port));
    await Promise.all(batch);
  }
  console.log('[sync-dsh-url] 扫描完成 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，开放端口 ' + open.length + ' 个，逐个校验 DSH 特征…');
  for (const p of open) {
    const base = 'http://127.0.0.1:' + p;
    if (seen.has(base)) continue;
    seen.add(base);
    if (await isDshWeb(base)) { found = { how: 'tcp-scan', base }; break; }
  }
}

if (!found) {
  console.log('[sync-dsh-url] 未探测到运行中的 DSH Web；config.json 保持 ' + (current || '(空)'));
  process.exit(current ? 0 : 1);
}

console.log('[sync-dsh-url] 探测到 DSH Web: ' + found.base + '（来源: ' + found.how + '）');
if (found.base === current) { console.log('[sync-dsh-url] 与当前配置一致，无需变更'); process.exit(0); }
if (!WRITE) { console.log('[sync-dsh-url] 加 --write 写回 config.json'); process.exit(0); }

cfg.dsh = cfg.dsh || {};
cfg.dsh.baseUrl = found.base;
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('[sync-dsh-url] 已写回 config.json: dsh.baseUrl = ' + found.base);
