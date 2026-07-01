// PM2 process manager config. Start with:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "race-innovations",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      cwd: __dirname,
      instances: 1, // keep at 1 — typing/presence state is per-process (in-memory)
      autorestart: true,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
