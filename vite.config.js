import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
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
        start_url: '/',
        icons: [
          { src: '/bird.svg', sizes: 'any', type: 'image/svg+xml' }
        ]
      }
    })
  ],
  optimizeDeps: {
    exclude: ['ggwave']
  },
  test: {
    environment: 'jsdom',
    globals: true
  }
})
