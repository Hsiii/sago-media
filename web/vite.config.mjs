import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = 'http://127.0.0.1:3000';

const config = defineConfig({
    base: '/admin/',
    plugins: [react()],
    server: {
        proxy: {
            '/activate': apiTarget,
            '/admin/login': apiTarget,
            '/auth': apiTarget,
            '/health': apiTarget,
            '/v1': {
                target: apiTarget,
                headers: process.env.MEDIA_ADMIN_TOKEN
                    ? {
                          Authorization: `Bearer ${process.env.MEDIA_ADMIN_TOKEN}`,
                      }
                    : undefined,
            },
        },
    },
});

export default config;
