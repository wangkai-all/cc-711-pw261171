#!/usr/bin/env node
// Development runner: demo gRPC server + station API + Vite dev server.
//
//   node scripts/dev.js            demo on 50051, station on 7070, vite on 5173
//   DEMO_PORT=... STATION_PORT=... node scripts/dev.js
//
// Each child gets its output prefixed; Ctrl-C stops all of them.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demoPort = process.env.DEMO_PORT || "50051";
const stationPort = process.env.STATION_PORT || "7070";

const children = [];

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const prefix = `[${name}] `;
  const forward = (stream, target) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
    stream.on("end", () => {
      if (buffer) target.write(`${prefix}${buffer}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`${prefix}stopped (${signal})`);
      return;
    }
    console.log(`${prefix}exited with code ${code}`);
    if (code !== 0) shutdown(1);
  });
  return child;
}

function shutdown(exitCode = 0) {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  // Give children a moment to close their sockets, then leave.
  setTimeout(() => process.exit(exitCode), 300).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`demo gRPC   http://127.0.0.1:${demoPort}`);
console.log(`station API http://127.0.0.1:${stationPort}`);
console.log("web UI      http://127.0.0.1:5173\n");

run("demo", process.execPath, ["demo/server.js"], { DEMO_PORT: demoPort });
run("station", process.execPath, ["server/index.js"], { PORT: stationPort });
run("vite", process.execPath, ["node_modules/vite/bin/vite.js", "--config", "web/vite.config.ts"], {
  STATION_TARGET: `http://127.0.0.1:${stationPort}`,
});
