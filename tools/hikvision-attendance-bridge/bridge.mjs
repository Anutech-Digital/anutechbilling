/**
 * Hikvision → ResellerOS attendance bridge.
 *
 * Runs on an office computer that's on the same network as the fingerprint
 * machine. Every POLL_SECONDS it reads NEW punches from the device (ISAPI
 * AcsEvent, HTTP digest auth) and POSTs them to the app's ingest endpoint.
 * The device stores its own log, so if this PC was off, the next run catches up
 * from the last synced time — no punches are lost.
 *
 * Zero npm dependencies — plain Node.js (v18+).
 *
 * Setup: copy config.example.json → config.json, fill it, then:  node bridge.mjs
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const STATE = path.join(DIR, "last-sync.txt");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// ── HTTP digest auth request to the device ───────────────────────────────────
function deviceRequest(method, urlPath, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const opts = { host: CFG.device_ip, port: CFG.device_port || 80, path: urlPath, method, insecureHTTPParser: true };
  return new Promise((resolve, reject) => {
    const first = http.request(opts, (res) => {
      if (res.statusCode !== 401) { collect(res).then((d) => resolve({ status: res.statusCode, data: d })); return; }
      const wa = res.headers["www-authenticate"] || "";
      res.resume();
      const get = (k) => (wa.match(new RegExp(`${k}="?([^",]+)"?`)) || [])[1];
      const realm = get("realm"), nonce = get("nonce"), qop = get("qop") || "auth", opaque = get("opaque");
      const cnonce = crypto.randomBytes(8).toString("hex"), nc = "00000001";
      const ha1 = md5(`${CFG.device_user}:${realm}:${CFG.device_pass}`);
      const ha2 = md5(`${method}:${urlPath}`);
      const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
      const auth = `Digest username="${CFG.device_user}", realm="${realm}", nonce="${nonce}", uri="${urlPath}", ` +
        `qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"${opaque ? `, opaque="${opaque}"` : ""}`;
      const second = http.request({ ...opts, headers: { Authorization: auth, "Content-Type": "application/json" } },
        (r2) => collect(r2).then((d) => resolve({ status: r2.statusCode, data: d })));
      second.on("error", reject);
      if (body) second.write(body);
      second.end();
    });
    first.on("error", reject);
    if (body) first.write(body);
    first.end();
  });
}
const collect = (res) => new Promise((r) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => r(s)); });

// ── Pull attendance events since `since` (ISO), paginated ─────────────────────
async function fetchPunches(since, until) {
  const punches = [];
  let pos = 0;
  for (let guard = 0; guard < 200; guard++) {
    const { status, data } = await deviceRequest("POST", "/ISAPI/AccessControl/AcsEvent?format=json", {
      AcsEventCond: { searchID: "reselleros", searchResultPosition: pos, maxResults: 30, major: 0, minor: 0, startTime: since, endTime: until },
    });
    if (status !== 200) throw new Error(`Device responded ${status}: ${data.slice(0, 200)}`);
    let json; try { json = JSON.parse(data); } catch { throw new Error("Bad JSON from device"); }
    const info = json?.AcsEvent?.InfoList ?? [];
    for (const e of info) {
      const bio = e.employeeNoString || e.employeeNo;
      if (bio && e.time) punches.push({ biometric_id: String(bio), timestamp: e.time });
    }
    const num = json?.AcsEvent?.numOfMatches ?? info.length;
    pos += num;
    if (num < 30 || (json?.AcsEvent?.responseStatusStrg === "NO MATCH")) break;
  }
  return punches;
}

// ── POST punches to the app ──────────────────────────────────────────────────
async function pushPunches(punches) {
  const res = await fetch(CFG.ingest_url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-key": CFG.ingest_key },
    body: JSON.stringify({ punches }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Ingest ${res.status}: ${JSON.stringify(j)}`);
  return j;
}

async function tick() {
  const now = new Date();
  const since = fs.existsSync(STATE) ? fs.readFileSync(STATE, "utf8").trim() : new Date(now.getTime() - 86400000).toISOString();
  const until = now.toISOString();
  try {
    const punches = await fetchPunches(since, until);
    if (punches.length) {
      const r = await pushPunches(punches);
      console.log(`[${now.toLocaleTimeString()}] sent ${punches.length} punches →`, r.days_updated, "days updated",
        r.unmatched_biometric_ids?.length ? `· unmatched: ${r.unmatched_biometric_ids.join(",")}` : "");
    } else {
      console.log(`[${now.toLocaleTimeString()}] no new punches`);
    }
    fs.writeFileSync(STATE, until);   // advance only after a successful cycle
  } catch (err) {
    console.error(`[${now.toLocaleTimeString()}] ERROR:`, err.message, "(will retry next cycle)");
  }
}

console.log(`Hikvision bridge started · device ${CFG.device_ip} · every ${CFG.poll_seconds || 60}s`);
tick();
setInterval(tick, (CFG.poll_seconds || 60) * 1000);
