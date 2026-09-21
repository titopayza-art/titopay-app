"use strict";

// Three processes, doing three different jobs.
//
//   titopay-api          the HTTP API, on every core, no chat sockets
//   titopay-chat         one instance, chat sockets only, on its own port
//   titopay-email-worker unchanged
//
// The API entry point is src/cluster.js rather than src/server.js, and pm2 runs
// it in fork mode. That looks backwards but is deliberate: the application does
// its own forking, so the same capacity is obtained under pm2, under systemd,
// or from a plain `node src/cluster.js`. The deployment notes are honest that
// production may not be pm2 at all, and capacity should not depend on guessing
// right.
//
// Chat is separate because chat state lives in process memory
// (src/realtime/chat-hub.js): a customer connected to one worker is invisible
// to the others, so an agent's reply would never arrive. Keeping the socket on
// one instance preserves today's behaviour exactly, with no change to the
// realtime code. nginx must route /v1/chat/socket to CHAT_PORT — see
// deploy/nginx-cluster.conf.

const os = require("os");

// One core held back for PostgreSQL, the chat instance and the email worker.
const API_WORKERS = Number(process.env.API_WORKERS) || Math.max(1, os.cpus().length - 1);
const API_DIR = process.env.TITOPAY_API_DIR || "/opt/titopay-api";
const CHAT_PORT = Number(process.env.CHAT_PORT) || 8081;

module.exports = {
  apps: [{
    name: "titopay-api",
    script: "src/cluster.js",
    cwd: API_DIR,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    // Per worker, not for the cluster as a whole, because pm2 sees one process.
    // Raised from 512M for that reason.
    max_memory_restart: "1500M",
    kill_timeout: 12000,
    listen_timeout: 10000,
    time: true,
    error_file: "/var/log/titopay-api/error.log",
    out_file: "/var/log/titopay-api/output.log",
    merge_logs: true,
    env: {
      NODE_ENV: "production",
      API_WORKERS: String(API_WORKERS),
      // The clustered workers must refuse socket upgrades. Without this a
      // customer could land on any worker and lose messages silently.
      CHAT_SOCKET_ENABLED: "false"
    }
  }, {
    name: "titopay-chat",
    script: "src/server.js",
    cwd: API_DIR,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    max_memory_restart: "512M",
    kill_timeout: 10000,
    listen_timeout: 10000,
    time: true,
    error_file: "/var/log/titopay-api/chat-error.log",
    out_file: "/var/log/titopay-api/chat-output.log",
    merge_logs: true,
    env: {
      NODE_ENV: "production",
      API_PORT: String(CHAT_PORT),
      CHAT_SOCKET_ENABLED: "true",
      // Counted in the pool budget alongside the API workers and the email
      // worker, so the three together stay under max_connections.
      API_WORKERS: String(API_WORKERS + 1)
    }
  }, {
    name: "titopay-email-worker",
    script: "src/email-worker.js",
    cwd: API_DIR,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    max_memory_restart: "384M",
    kill_timeout: 15000,
    time: true,
    error_file: "/var/log/titopay-api/email-worker-error.log",
    out_file: "/var/log/titopay-api/email-worker-output.log",
    merge_logs: true,
    env: {
      NODE_ENV: "production",
      API_WORKERS: String(API_WORKERS + 1)
    }
  }]
};
