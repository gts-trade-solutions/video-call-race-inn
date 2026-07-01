import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Accent is driven by CSS variables so it can be themed at runtime.
        teams: {
          purple: "rgb(var(--accent) / <alpha-value>)", // primary
          purpleDark: "rgb(var(--accent-dark) / <alpha-value>)",
          purpleDarker: "rgb(var(--accent-darker) / <alpha-value>)", // nav rail
          bg: "#f5f5f5",
          panel: "#ffffff",
          dark: "#1f1f1f",
          darker: "#141414",
          stage: "#2d2c2c",
          gray: "#616161",
          line: "#e0e0e0",
        },
      },
      fontFamily: {
        sans: [
          '"Segoe UI"',
          "system-ui",
          "-apple-system",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
