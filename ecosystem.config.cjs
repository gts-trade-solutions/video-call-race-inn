// PM2 process manager config. Start with:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "meetings-app",
      script: "node_modules/next/dist/bin/next",
      // Port is taken from the PORT env below (3009 on the VPS — 3000 is used by
      // another app). Change PORT to move the app to a different port.
      args: "start",
      cwd: __dirname,
      instances: 1, // keep at 1 — typing/presence state is per-process (in-memory)
      autorestart: true,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3009,
      },
    },
  ],
};
