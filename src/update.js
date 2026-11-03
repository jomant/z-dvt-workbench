"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REPO = process.env.ZDVT_UPDATE_REPO || "jomant/z-dvt-workbench";
const ASSET = "Z-DVT-Workbench-Setup.exe";

function parts(version) {
  return String(version || "").trim().replace(/^v/i, "").split(".").map((piece) => {
    const n = parseInt(piece, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function newerThan(remote, local) {
  const a = parts(remote);
  const b = parts(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

async function check(localVersion) {
  if (process.env.ZDVT_NO_UPDATE === "1") return null;
  const response = await fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Z-DVT-Workbench",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Update check failed (" + response.status + ")");
  const body = await response.json();
  const version = String(body.tag_name || "").replace(/^v/i, "");
  if (!version || !newerThan(version, localVersion)) return null;
  const asset = (body.assets || []).find((item) => item.name === ASSET);
  if (!asset || !asset.browser_download_url) return null;
  return {
    version,
    notes: String(body.body || "").trim(),
    url: asset.browser_download_url,
    name: asset.name,
  };
}

async function download(offer) {
  const response = await fetch(offer.url, {
    headers: { "User-Agent": "Z-DVT-Workbench", Accept: "application/octet-stream" },
  });
  if (!response.ok) throw new Error("Download failed (" + response.status + ")");
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length < 1000000 || data[0] !== 0x4d || data[1] !== 0x5a) {
    throw new Error("The downloaded installer is not the setup program.");
  }
  const file = path.join(os.tmpdir(), ASSET);
  fs.writeFileSync(file, data);
  return file;
}

const HELPER = "Z-DVT-Workbench-update.cmd";
const RESULT = "Z-DVT-Workbench-update-result.txt";
const LOG = "Z-DVT-Workbench-update.log";

function spawnBreakaway(scriptPath) {
  // cmd's start leaves the helper outside this process. A detached PowerShell
  // exits immediately here, so the setup never opened and the version stayed put.
  const child = spawn("cmd.exe", ["/d", "/c", "start", "", "/min", scriptPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function launchInstaller(file, options) {
  const relaunch = !options || options.relaunch !== false;
  const setup = String(file);
  const helper = path.join(os.tmpdir(), HELPER);
  const result = path.join(os.tmpdir(), RESULT);
  const log = path.join(os.tmpdir(), LOG);
  const app = path.join(process.env.ProgramFiles || "C:\\Program Files", "Z-DVT Workbench", "Z-DVT Workbench.exe");
  const lines = [
    "@echo off",
    "ping -n 3 127.0.0.1 >nul",
    "set /a N=0",
    ":wait",
    "tasklist /FI \"IMAGENAME eq Z-DVT Workbench.exe\" | find /I \"Z-DVT Workbench.exe\" >nul",
    "if errorlevel 1 goto run",
    "set /a N+=1",
    "if %N% GEQ 20 goto run",
    "ping -n 2 127.0.0.1 >nul",
    "goto wait",
    ":run",
    "call \"" + setup + "\" /SILENT /NORESTART /CLOSEAPPLICATIONS /LOG=\"" + log + "\"",
    "set CODE=%ERRORLEVEL%",
    "> \"" + result + "\" echo %CODE%",
  ];
  if (relaunch) lines.push("if exist \"" + app + "\" start \"\" \"" + app + "\"");
  fs.writeFileSync(helper, lines.join("\r\n") + "\r\n");
  spawnBreakaway(helper);
  return helper;
}

function consumeUpdateResult() {
  const result = path.join(os.tmpdir(), RESULT);
  try {
    if (!fs.existsSync(result)) return null;
    const code = fs.readFileSync(result, "utf8").replace(/^\uFEFF/, "").trim();
    fs.unlinkSync(result);
    return code;
  } catch {
    return null;
  }
}

module.exports = {
  REPO,
  ASSET,
  newerThan,
  check,
  download,
  launchInstaller,
  spawnBreakaway,
  consumeUpdateResult,
};
