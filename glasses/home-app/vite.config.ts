import { defineConfig } from 'vite';
// Relative asset paths: the same build is served at / on the laptop and at /hud/ behind Tailscale Serve.
export default defineConfig({ base: './', server: { host: '0.0.0.0', port: 5183, strictPort: true } });
