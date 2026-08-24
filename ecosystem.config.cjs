/**
 * PM2 Ecosystem Config — URBONT Production Clustering
 *
 * Usage:
 *   npm run build
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup
 *
 * Socket.IO requires sticky sessions so all requests from a given client
 * always land on the same worker. PM2 handles this automatically in
 * cluster mode when instances > 1 (uses round-robin + sticky via the
 * OS-level SO_REUSEPORT on Linux, or explicit sticky via --node-args).
 *
 * For full multi-server clustering, add a Redis adapter:
 *   npm install @socket.io/redis-adapter ioredis
 * and configure it in server/services/socketService.ts
 */

module.exports = {
  apps: [
    {
      name: 'urbont-api',
      script: 'dist/server.js',
      instances: process.env.WEB_CONCURRENCY || 'max',
      exec_mode: 'cluster',
      // Socket.IO sticky sessions via PM2 built-in
      // Requires pm2 >= 5.x
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 5000,
      },
      // Graceful restart: wait for in-flight requests to finish
      kill_timeout: 10000,
      listen_timeout: 8000,
      // Log configuration
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
