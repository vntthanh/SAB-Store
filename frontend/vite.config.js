import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],

	esbuild: {
		loader: 'jsx',
		include: /src\/.*\.jsx?$/,
		exclude: [],
		target: 'es2015',
	},

	optimizeDeps: {
		esbuildOptions: {
			loader: {
				'.js': 'jsx',
			},
		},
	},

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
		minify: 'esbuild',
		target: 'es2015',
		chunkSizeWarningLimit: 1000,
		rollupOptions: {
			output: {
				manualChunks: {
					vendor: ['react', 'react-dom', 'react-router-dom'],
					ui: ['react-toastify', 'sweetalert2'],
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

	// Path resolution
	resolve: {
		alias: {
			'@': '/src',
		},
	},

	// Environment variables prefix
	envPrefix: 'VITE_',
});
