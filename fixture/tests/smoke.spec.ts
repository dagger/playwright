import { test, expect } from '@playwright/test';

test('serves the fixture page via the bound service', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveTitle('Playwright E2E Fixture');
	await expect(page.locator('#greeting')).toHaveText('hello from the fixture server');
});

test('localhost proxy provides a secure-context origin', async ({ page }) => {
	// Set when the module's localhostProxy option is enabled.
	const localhostURL = process.env.PLAYWRIGHT_LOCALHOST_BASE_URL;
	test.skip(!localhostURL, 'localhostProxy not enabled');
	await page.goto(localhostURL!);
	await expect(page).toHaveTitle('Playwright E2E Fixture');
	// localhost is a secure context even over http — the reason the proxy exists.
	expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
});
