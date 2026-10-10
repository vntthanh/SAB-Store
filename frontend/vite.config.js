import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],

	// Development server configuration
	server: {
		port: 3000,
		host: true,
		strictPort: true,
		// Dev-only proxy target: the backend always runs on :5000 locally,
		// so this needs no env var (VITE_API_URL is retired - AD-3).
		proxy: {
			'/api': {
				target: 'http://localhost:5000',
				changeOrigin: true,
				secure: false,
			}
		}
	},

	// Build configuration
	build: {
		outDir: 'build',
		sourcemap: false,
		chunkSizeWarningLimit: 1000,
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{ name: 'vendor', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
						{ name: 'ui', test: /node_modules[\\/](react-toastify|sweetalert2)[\\/]/ },
					],
				},
			},
		},
	},

	// Preview server configuration
	preview: {
		port: 3000,
		host: true,
		strictPort: true,
	},
});
