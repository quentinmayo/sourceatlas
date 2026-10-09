import { test, expect } from '@playwright/test';
test('inventory search, type filtering, source trace, gaps, and collector instructions', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Sample workspace', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Asset type' }).selectOption('REPOSITORY');
  await page.getByRole('textbox', { name: 'Search inventory' }).fill('payments');
  await expect(
    page.locator('.asset-button').filter({ hasText: 'example/payments-api' }),
  ).toHaveCount(1);
  await page.locator('.asset-button').filter({ hasText: 'example/payments-api' }).click();
  await expect(page.getByRole('heading', { name: 'From source to runtime' })).toBeVisible();
  await expect(page.locator('.graph-node')).toHaveCount(5);
  await page.getByRole('button', { name: /Coverage gaps/ }).click();
  await expect(page.getByRole('heading', { name: 'Missing build provenance' })).toBeVisible();
  await page.getByRole('button', { name: 'Data sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: '03 / Kubernetes' })).toBeVisible();
  await page.screenshot({ path: 'test-results/sourceatlas-desktop.png', fullPage: true });
});
test('mobile inventory has no page overflow and supports tracing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Asset inventory', exact: true })).toBeVisible();
  await expect(page.getByText('Sample workspace', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Asset type' }).selectOption('WORKLOAD');
  await expect(page.locator('tbody tr')).toHaveCount(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/sourceatlas-mobile.png', fullPage: true });
});

test('workspace access dialog supports keyboard dismissal', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Workspace access/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
