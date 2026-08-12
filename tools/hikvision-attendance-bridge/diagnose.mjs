/**
 * Diagnostic — finds the working protocol + port for this device's web API.
 * Run:  node diagnose.mjs
 * Tries http/https on a few ports and prints which one answers deviceInfo=200.
 */
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const collect = (res) => new Promise((r) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => r(s)); });

function req(useHttps, port, method, urlPath, bodyObj) {
  const lib = useHttps ? https : http;
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const base = { host: CFG.device_ip, port, path: urlPath, method, timeout: 6000, insecureHTTPParser: true };
  const extra = useHttps
    ? { rejectUnauthorized: false, minVersion: "TLSv1", ciphers: "DEFAULT@SECLEVEL=0" }
    : {};
  return new Promise((resolve, reject) => {
    const first = lib.request({ ...base, ...extra }, (res) => {
      if (res.statusCode !== 401) { collect(res).then((d) => resolve({ status: res.statusCode, data: d })); return; }
      const wa = res.headers["www-authenticate"] || ""; res.resume();
      const get = (k) => (wa.match(new RegExp(`${k}="?([^",]+)"?`)) || [])[1];
      const realm = get("realm"), nonce = get("nonce"), qop = get("qop") || "auth", opaque = get("opaque");
      const cnonce = crypto.randomBytes(8).toString("hex"), nc = "00000001";
      const ha1 = md5(`${CFG.device_user}:${realm}:${CFG.device_pass}`);
      const ha2 = md5(`${method}:${urlPath}`);
      const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
      const auth = `Digest username="${CFG.device_user}", realm="${realm}", nonce="${nonce}", uri="${urlPath}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"${opaque ? `, opaque="${opaque}"` : ""}`;
      const second = lib.request({ ...base, ...extra, headers: { Authorization: auth, "Content-Type": "application/json" } },
        (r2) => collect(r2).then((d) => resolve({ status: r2.statusCode, data: d })));
      second.on("error", reject); second.on("timeout", () => second.destroy(new Error("timeout")));
      if (body) second.write(body); second.end();
    });
    first.on("error", reject); first.on("timeout", () => first.destroy(new Error("timeout")));
    if (body) first.write(body); first.end();
  });
}

const combos = [
  ["http",  false, 80],
  ["https", true,  443],
  ["https", true,  80],
  ["http",  false, 8080],
];

console.log(`[v3 legacy-TLS] Finding working web-API on ${CFG.device_ip} (user "${CFG.device_user}")\n`);
for (const [label, useHttps, port] of combos) {
  try {
    const r = await req(useHttps, port, "GET", "/ISAPI/System/deviceInfo?format=json");
    const snip = String(r.data).replace(/\s+/g, " ").slice(0, 70);
    console.log(`${label}://${CFG.device_ip}:${port}  ->  status=${r.status}  ${snip}`);
  } catch (e) {
    console.log(`${label}://${CFG.device_ip}:${port}  ->  ERROR: ${e.message}`);
  }
}
console.log("\n(status=200 wala combo hi sahi hai — wahi bridge me set karenge)");
