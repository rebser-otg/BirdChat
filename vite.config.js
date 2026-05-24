import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'

// Build version: short git SHA + UTC build date, shown in the UI so a device
// can confirm it is running the latest deployed code (PWAs cache aggressively).
let gitSha = 'local'
try { gitSha = execSync('git rev-parse --short HEAD').toString().trim() } catch { /* no git */ }
const buildVersion = `${gitSha} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`

export default defineConfig({
  base: '/BirdChat/',
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
  },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'BirdChat',
        short_name: 'BirdChat',
        description: 'Chat with bird sounds',
        theme_color: '#3d7a3d',
        background_color: '#1a2e1a',
        display: 'standalone',
        start_url: '/BirdChat/',
        scope: '/BirdChat/',
        icons: [
          { src: 'bird.svg', sizes: 'any', type: 'image/svg+xml' }
        ]
      }
    })
  ],
  test: {
    environment: 'jsdom',
    globals: true
  }
})
