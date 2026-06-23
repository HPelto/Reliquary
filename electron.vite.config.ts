import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  // externalize third-party deps (electron-updater) so they load from
  // node_modules at runtime instead of being bundled into the main output.
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        // bundled sound effects (and future audio assets) live in /audio
        '@audio': resolve(__dirname, 'audio'),
        // repo root, so the renderer can bundle the LICENSE (imported ?raw)
        '@root': resolve(__dirname)
      }
    },
    // let the dev server read the /audio folder, which sits outside the renderer root
    server: { fs: { allow: [resolve(__dirname)] } },
    plugins: [react(), tailwindcss()]
  }
})
