import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          "pdf-renderer": ["pdfjs-dist"],
          "pdf-writer": ["pdf-lib"],
          archive: ["jszip"],
          ocr: ["tesseract.js"],
          converters: ["mammoth", "docx"],
          icons: ["lucide-react"],
        },
      },
    },
  },
});
