"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { Workbench, helpRows } = require("./engine");
const updater = require("./update");
const { settingsDir } = require("./paths");

const PORT = Number(process.env.DVT_PORT) || 8755;
const publicDir = path.resolve(__dirname, "..", "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function json(res, body) {
  const text = JSON.stringify(body);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("Request is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(engine, port) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/state") {
        json(res, engine.snapshot({
          frame: url.searchParams.get("frame"),
          info: url.searchParams.get("info"),
          trace: url.searchParams.get("trace"),
          traceEpoch: url.searchParams.get("traceEpoch"),
          logEpoch: url.searchParams.get("logEpoch"),
          infoEpoch: url.searchParams.get("infoEpoch"),
        }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/help") {
        json(res, helpRows());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/plugins") {
        json(res, engine.pluginList());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/act") {
        const msg = JSON.parse((await readBody(req)) || "{}");
        const result = await engine.handle(msg);
        json(res, result);
        if (result && result.shutdown) setTimeout(() => process.exit(0), 80);
        return;
      }
      const rel = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "") || "index.html";
      const file = path.resolve(publicDir, rel);
      if (file !== publicDir && !file.startsWith(publicDir + path.sep)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function browserCandidates() {
  const pf = process.env.PROGRAMFILES || "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  return [
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter((file) => file && fs.existsSync(file));
}

function macBrowserApp() {
  const home = os.homedir();
  const apps = [
    "/Applications/Google Chrome.app",
    path.join(home, "Applications", "Google Chrome.app"),
    "/Applications/Microsoft Edge.app",
    path.join(home, "Applications", "Microsoft Edge.app"),
  ];
  return apps.find((app) => fs.existsSync(app)) || "";
}

function openBrowser(port) {
  const url = "http://127.0.0.1:" + port;
  if (process.platform === "darwin") {
    const app = macBrowserApp();
    if (app) {
      spawn("open", ["-na", app, "--args", "--app=" + url, "--window-size=1500,940"], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const browsers = browserCandidates();
  if (!browsers.length) {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn(browsers[0], [`--app=${url}`, "--window-size=1500,940"], { detached: true, stdio: "ignore" }).unref();
}

async function main() {
  const engine = new Workbench();
  engine.start();
  try {
    await listen(engine, PORT);
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      if (!process.env.DVT_NO_BROWSER) openBrowser(PORT);
      process.exit(0);
    }
    throw err;
  }
  const logDir = settingsDir();
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "server.log"), new Date().toISOString() + " listening " + PORT + "\n");
  } catch { /* logging is optional */ }
  console.log("Z-DVT Workbench  http://127.0.0.1:" + PORT);
  if (!process.env.DVT_NO_BROWSER) openBrowser(PORT);
  updater.check(engine.version).then((offer) => {
    if (!offer) return;
    engine.updateOffer = offer;
    engine.info("Version " + offer.version + " is available. Use the bar at the bottom to install it.", "help");
  }).catch(() => { /* a missed check can be repeated from the Help menu */ });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { listen, PORT };
