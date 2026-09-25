import { defineConfig, devices } from '@playwright/test';

// A second project nested in the first, with no package.json of its own: the
// module installs dependencies from the enclosing fixture/package.json.
export default defineConfig({
	testDir: './tests',
	reporter: [['list']],
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
