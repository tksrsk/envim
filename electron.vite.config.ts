import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: "main/index.ts",
      }
    }
  },
  preload: {
    build: {
      lib: {
        entry: "preload/index.ts",
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: "index.html",
      },
    },
    root: ".",
    plugins: [react()],
  }
});
