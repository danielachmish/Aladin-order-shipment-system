const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('manager inventory screens', () => {
  test('inventory shortages page loads with the item/supplier toggle', async ({ page }) => {
    await login(page, 'manager');
    await page.getByRole('button', { name: 'חוסרי מלאי' }).click();
    await expect(page.locator('.app-page-title')).toHaveText('חוסרי מלאי');
    await expect(page.getByRole('button', { name: 'לפי ספק' })).toBeVisible();
    await page.getByRole('button', { name: 'לפי ספק' }).click();
    await expect(page.locator('.error-box')).toHaveCount(0);
  });

  test('back-in-stock page loads for a manager', async ({ page }) => {
    await login(page, 'manager');
    await page.getByRole('button', { name: 'חזר למלאי' }).click();
    await expect(page.locator('.app-page-title')).toHaveText('חזר למלאי');
  });

  test('management tools page shows the WooCommerce card only for system_admin, not warehouse_manager', async ({ page }) => {
    await login(page, 'manager');
    await page.getByRole('button', { name: 'כלי ניהול' }).click();
    await expect(page.getByText('חיבור לאתר המכירות')).toHaveCount(0);
  });

  test('system_admin sees the WooCommerce settings card', async ({ page }) => {
    await login(page, 'admin');
    await page.getByRole('button', { name: 'כלי ניהול' }).click();
    await expect(page.getByText('חיבור לאתר המכירות')).toBeVisible();
  });
});
