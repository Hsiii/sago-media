import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const config = defineConfig({
    base: '/admin/',
    plugins: [react()],
    server: {
        proxy: {
            '/activate': 'http://127.0.0.1:3000',
            '/admin/login': 'http://127.0.0.1:3000',
            '/auth': 'http://127.0.0.1:3000',
            '/health': 'http://127.0.0.1:3000',
            '/v1': 'http://127.0.0.1:3000',
        },
    },
});

export default config;
