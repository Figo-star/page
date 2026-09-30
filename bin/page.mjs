#!/usr/bin/env node
// page — message your coding agent from your phone.
// Long-polls Telegram (outbound HTTPS: no ports, no Tailscale needed),
// runs opencode on your machine, replies with the result in chunks.
// Zero dependencies, Node 18+.
//
// Usage:
//   PAGE_BOT_TOKEN=<token from @BotFather> node bin/page.mjs [--config=page.json] [--once]
//   node bin/page.mjs --selftest   (no network: chunking + config + spawn plumbing)
import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";

const args = process.argv.slice(2);
const flag = (n) => {
  const hit = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "true" : hit.slice(eq + 1);
};

function chunk(text, limit = 4000) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit; // no good newline: hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  out.push(rest);
  return out;
}

function loadConfig() {
  const path = flag("config") || "page.json";
  if (!existsSync(path)) throw new Error(`config not found: ${path} (copy page.example.json)`);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(cfg.allowFrom) || cfg.allowFrom.length === 0)
    throw new Error("config.allowFrom must list your Telegram chat id(s) — never run open to the world");
  return cfg;
}

function spawn(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr.trim() || err.message));
      resolve((stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : ""));
    });
  });
}

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

async function handleMessage(cfg, token, msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || "").trim();
  if (!chatId || !text) return;
  if (!cfg.allowFrom.includes(chatId)) return; // silent drop: never confirm existence to strangers
  if (text === "/ping") return tg(token, "sendMessage", { chat_id: chatId, text: "pong" });
  if (text === "/help") return tg(token, "sendMessage", { chat_id: chatId, text: "Send any task — I run it in " + cfg.projectDir + " and reply with the result." });
  const agent = cfg.agent ?? { cmd: "opencode", args: ["run", "--auto"], cwd: cfg.projectDir, timeoutMs: 600000 };
  let out;
  try {
    out = await spawn(agent.cmd, [...(agent.args ?? []), text], { cwd: agent.cwd || cfg.projectDir, timeout: agent.timeoutMs ?? 600000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    out = "run failed: " + e.message;
  }
  out = out.trim().slice(-16000) || "(empty output)";
  for (const part of chunk(out)) await tg(token, "sendMessage", { chat_id: chatId, text: part });
}

async function loop(cfg, token, once) {
  let offset = 0;
  for (;;) {
    const updates = await tg(token, "getUpdates", { offset, timeout: 30 });
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.message) await handleMessage(cfg, token, u.message).catch((e) => console.error("page: " + e.message));
    }
    if (once) return;
  }
}

async function selftest() {
  const assert = (c, m) => { if (!c) throw new Error("selftest: " + m); console.log("ok — " + m); };
  assert(chunk("a".repeat(9000)).length === 3, "long text splits into 3 chunks");
  assert(chunk("x\n".repeat(3000)).every((c) => c.length <= 4000), "newline-aware splits respect limit");
  assert(chunk("short").length === 1, "short text untouched");
  const out = await spawn(process.execPath, ["-e", "console.log('hi')"], { timeout: 10000 });
  assert(out.trim() === "hi", "agent spawn plumbing works");
  const reach = await fetch("https://api.telegram.org/", { method: "GET" }).then((r) => r.status).catch(() => 0);
  assert(reach !== 0, "telegram API reachable");
  console.log("page selftest: ALL GREEN");
}

if (flag("selftest")) await selftest();
else {
  const token = process.env.PAGE_BOT_TOKEN;
  if (!token) {
    console.error("page: set PAGE_BOT_TOKEN (talk to @BotFather on Telegram to get one)");
    process.exit(1);
  }
  const cfg = loadConfig();
  console.log(`page: serving ${cfg.projectDir} (chat allowlist: ${cfg.allowFrom.length}) — Ctrl+C to stop`);
  await loop(cfg, token, flag("once") === "true").catch((e) => { console.error("page: " + e.message); process.exit(1); });
}
