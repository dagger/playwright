import { test, expect } from '@playwright/test';

test('renders inline content without a service', async ({ page }) => {
	await page.setContent('<title>Nested Fixture</title><h1>nested project</h1>');
	await expect(page).toHaveTitle('Nested Fixture');
});

test('runs from its own config directory', async () => {
	expect(process.cwd()).toMatch(/\/fixture\/nested$/);
});
