const ErrorLogger = require('./errorLogger');

class PerformanceMonitor {
	constructor() {
		this.metrics = {
			requests: 0,
			errors: 0,
			slowRequests: 0,
			memoryWarnings: 0
		};

		this.startTime = Date.now();
	}

	startMonitoring(intervalMs = 60000) {
		setInterval(() => {
			this.checkHealth();
		}, intervalMs);

		ErrorLogger.logInfo('Performance monitoring started', {
			interval: `${intervalMs}ms`
		});
	}

	checkHealth() {
		const memUsage = process.memoryUsage();
		const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
		const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
		const memUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

		const metrics = {
			uptime: Math.round(process.uptime()),
			memory: {
				used: memUsedMB,
				total: memTotalMB,
				percentage: memUsagePercent.toFixed(2),
				rss: Math.round(memUsage.rss / 1024 / 1024),
				external: Math.round(memUsage.external / 1024 / 1024)
			},
			cpu: process.cpuUsage(),
			requests: this.metrics.requests,
			errors: this.metrics.errors,
			slowRequests: this.metrics.slowRequests,
			errorRate: this.metrics.requests > 0
				? ((this.metrics.errors / this.metrics.requests) * 100).toFixed(2)
				: 0
		};

		if (memUsagePercent > 90) {
			ErrorLogger.logCritical('Critical memory usage',
				new Error('Memory threshold exceeded'),
				metrics
			);
			this.metrics.memoryWarnings++;

			if (global.gc && this.metrics.memoryWarnings > 3) {
				ErrorLogger.logWarning('Forcing garbage collection');
				global.gc();
			}
		} else if (memUsagePercent > 80) {
			ErrorLogger.logWarning('High memory usage', metrics);
		} else {
			ErrorLogger.logDebug('Health check', metrics);
		}

		this.resetMetrics();
	}

	recordRequest() {
		this.metrics.requests++;
	}

	recordError() {
		this.metrics.errors++;
	}

	recordSlowRequest() {
		this.metrics.slowRequests++;
	}

	resetMetrics() {
		this.metrics = {
			requests: 0,
			errors: 0,
			slowRequests: 0,
			memoryWarnings: this.metrics.memoryWarnings
		};
	}

	getMetrics() {
		return {
			...this.metrics,
			uptime: process.uptime(),
			memory: process.memoryUsage(),
			startTime: this.startTime
		};
	}
}

const monitor = new PerformanceMonitor();

function trackMemoryLeaks() {
	if (typeof global.gc !== 'function') {
		ErrorLogger.logWarning('Garbage collection not exposed. Run with --expose-gc flag for memory tracking');
		return;
	}

	const samples = [];
	const SAMPLE_INTERVAL = 300000;
	const MAX_SAMPLES = 10;

	setInterval(() => {
		if (global.gc) {
			global.gc();
		}

		const memUsage = process.memoryUsage();
		samples.push({
			timestamp: Date.now(),
			heapUsed: memUsage.heapUsed,
			heapTotal: memUsage.heapTotal
		});

		if (samples.length > MAX_SAMPLES) {
			samples.shift();
		}

		if (samples.length >= 5) {
			const trend = samples.slice(-5);
			const increasing = trend.every((sample, i) =>
				i === 0 || sample.heapUsed > trend[i - 1].heapUsed
			);

			if (increasing) {
				const increase = trend[trend.length - 1].heapUsed - trend[0].heapUsed;
				const increaseMB = Math.round(increase / 1024 / 1024);

				if (increaseMB > 50) {
					ErrorLogger.logWarning('Potential memory leak detected', {
						increaseMB,
						samples: trend.length,
						currentHeapMB: Math.round(memUsage.heapUsed / 1024 / 1024)
					});
				}
			}
		}
	}, SAMPLE_INTERVAL);

	ErrorLogger.logInfo('Memory leak tracking started', {
		interval: `${SAMPLE_INTERVAL}ms`,
		maxSamples: MAX_SAMPLES
	});
}

function setupProcessMonitoring() {
	monitor.startMonitoring();

	if (process.env.TRACK_MEMORY_LEAKS === 'true') {
		trackMemoryLeaks();
	}

	process.on('exit', (code) => {
		ErrorLogger.logInfo('Process exiting', {
			code,
			uptime: process.uptime(),
			metrics: monitor.getMetrics()
		});
	});
}

module.exports = {
	monitor,
	setupProcessMonitoring
};
