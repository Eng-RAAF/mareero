#!/usr/bin/env node
// Mareero shop server: runs the database, functions and web app on one computer in the shop with Docker,
// so every PC on the shop network keeps working when the internet is down.
//
//   npm run shop:setup              first-time setup (or re-run after changing the server's IP address)
//   npm run shop:start | shop:stop  start / stop the server
//   npm run shop:update             push code changes (functions + web app) to the shop server
//   npm run shop:backup             save all shop data to backups/shop-<date>.zip
//   npm run shop:import -- <file>   load a backup / cloud export (.zip) into the shop server
//
// Options for shop:setup:  --host <ip>   address other PCs use to reach this computer (default: auto-detected)
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.shop");
const CONVEX = join(ROOT, "node_modules", "convex", "bin", "main.js");
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
const WEB_PORT = 8080;

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function run(cmd, args, { capture = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (r.error && !allowFail) fail(`Could not run ${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`${cmd} ${args.join(" ")} failed (exit code ${r.status}).`);
  return { ok: !r.error && r.status === 0, out: (r.stdout ?? "").trim() };
}
const compose = (...args) => run("docker", ["compose", "--env-file", ENV_FILE, ...args]);
const convex = (args, opts) => run(process.execPath, [CONVEX, ...args, "--env-file", ENV_FILE], opts);

function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function writeEnv({ host, adminKey }) {
  writeFileSync(
    ENV_FILE,
    `# Mareero shop server (written by scripts/shop-server.mjs). Keep private: the admin key gives full access.
# Address other PCs use to reach this computer
SHOP_HOST=${host}

# Used by the Convex CLI (npm run shop:update / shop:backup)
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
CONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey ?? ""}

# Used when building the web app for the shop network
VITE_CONVEX_URL=http://${host}:3210
`,
  );
}

function detectHost() {
  const candidates = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
  return candidates.find((a) => /^(192\.168|10)\./.test(a)) ?? candidates.find((a) => /^172\./.test(a)) ?? candidates[0] ?? "127.0.0.1";
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function requireDocker() {
  if (!run("docker", ["compose", "version"], { capture: true, allowFail: true }).ok) {
    fail("Docker is not installed or not running. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, then try again.");
  }
}

function requireSetup() {
  const env = readEnv();
  if (!env.CONVEX_SELF_HOSTED_ADMIN_KEY) fail("The shop server is not set up yet. Run: npm run shop:setup");
  return env;
}

function pushFunctions() {
  console.log("\n▶ Pushing database schema and functions to the shop server…");
  convex(["deploy"]);
}

function buildWeb() {
  console.log("\n▶ Building the web app for the shop network…");
  run(process.execPath, [VITE, "build", "--mode", "shop", "--outDir", "dist-shop", "--emptyOutDir"]);
}

/** Sign-in keys (only created once, so existing sessions stay valid) and the site address. */
function configureAuth(host) {
  console.log("\n▶ Configuring sign-in…");
  const vars = { SITE_URL: `http://${host}:${WEB_PORT}` };
  const hasKeys = convex(["env", "get", "JWKS"], { capture: true, allowFail: true }).out.startsWith("{");
  if (!hasKeys) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trimEnd().replace(/\n/g, " ");
    vars.JWT_PRIVATE_KEY = `"${pem}"`;
    vars.JWKS = `'${JSON.stringify({ keys: [{ use: "sig", alg: "RS256", ...publicKey.export({ format: "jwk" }) }] })}'`;
  }
  const tmp = join(tmpdir(), `mareero-auth-${process.pid}.env`);
  writeFileSync(tmp, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  try {
    convex(["env", "set", "--from-file", tmp, "--force"]);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function printDone(host) {
  console.log(`
✔ Mareero shop server is running.

  App (any PC on the shop network):  http://${host}:${WEB_PORT}
  App (on this computer):            http://localhost:${WEB_PORT}
  Admin dashboard (this computer):   http://localhost:6791   (log in with the admin key in .env.shop)

  • Other PCs need Windows Firewall to allow inbound TCP ports ${WEB_PORT}, 3210 and 3211 on this computer.
  • Give this computer a fixed IP address in your router. If the address changes, run: npm run shop:setup
  • Data lives in the Docker volume "data" — back it up regularly: npm run shop:backup
`);
}

function setup() {
  requireDocker();
  const env = readEnv();
  const host = argValue("--host") ?? detectHost();
  console.log(`▶ Shop server address: ${host}  (change with: npm run shop:setup -- --host <ip>)`);
  writeEnv({ host, adminKey: env.CONVEX_SELF_HOSTED_ADMIN_KEY });

  console.log("\n▶ Starting the database server (first run downloads it — needs internet once)…");
  compose("up", "-d", "--wait", "backend", "dashboard");

  let adminKey = env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (!adminKey) {
    const out = run("docker", ["compose", "--env-file", ENV_FILE, "exec", "backend", "./generate_admin_key.sh"], { capture: true }).out;
    adminKey = out.split(/\r?\n/).filter(Boolean).pop();
    if (!adminKey) fail("Could not read the admin key from the server.");
    writeEnv({ host, adminKey });
  }

  pushFunctions();
  configureAuth(host);
  buildWeb();
  compose("up", "-d", "--force-recreate", "web");
  printDone(host);
}

const command = process.argv[2];
switch (command) {
  case "setup":
    setup();
    break;
  case "start": {
    requireDocker();
    const env = requireSetup();
    compose("up", "-d", "--wait");
    printDone(env.SHOP_HOST);
    break;
  }
  case "stop":
    requireDocker();
    requireSetup();
    compose("stop");
    break;
  case "update": {
    requireDocker();
    const env = requireSetup();
    compose("up", "-d", "--wait", "backend");
    pushFunctions();
    buildWeb();
    compose("up", "-d", "--force-recreate", "web");
    printDone(env.SHOP_HOST);
    break;
  }
  case "backup": {
    requireSetup();
    mkdirSync(join(ROOT, "backups"), { recursive: true });
    const file = join("backups", `shop-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.zip`);
    convex(["export", "--include-file-storage", "--path", file]);
    console.log(`\n✔ Backup saved to ${file}`);
    break;
  }
  case "import": {
    requireSetup();
    const file = process.argv[3];
    if (!file || !existsSync(file)) fail("Give the .zip to load, e.g.  npm run shop:import -- backups/cloud.zip");
    // The CLI shows what will change and asks for confirmation before replacing anything
    convex(["import", "--replace-all", file]);
    break;
  }
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 11).join("\n").replace(/^\/\/ ?/gm, ""));
}
