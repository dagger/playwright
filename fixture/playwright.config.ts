import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	reporter: [['list'], ['html', { open: 'never' }]],
	use: {
		// Contract with the dagger playwright module: when a service is wired,
		// PLAYWRIGHT_BASE_URL points at it.
		baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8080',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
