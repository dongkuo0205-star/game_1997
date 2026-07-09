import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        arcade: {
          bg: "#16121f",
          panel: "#251c31",
          neon: "#ff5c73",
          cyan: "#56c8d8",
          yellow: "#f5c95c",
          green: "#63d68c",
          red: "#e85f5f",
        },
      },
      fontFamily: {
        arcade: ["var(--font-arcade)", "'Press Start 2P'", "monospace"],
      },
      boxShadow: {
        neon: "0 0 6px rgba(255,92,115,0.55), 0 0 16px rgba(255,92,115,0.25)",
        cyan: "0 0 6px rgba(86,200,216,0.55), 0 0 16px rgba(86,200,216,0.25)",
      },
    },
  },
  plugins: [],
};

export default config;
