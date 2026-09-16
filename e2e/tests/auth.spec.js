const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('login', () => {
  test('warehouse manager lands on the dashboard', async ({ page }) => {
    await login(page, 'manager');
    await expect(page.locator('.app-page-title')).toHaveText('דשבורד');
  });

  test('warehouse worker lands on the orders list', async ({ page }) => {
    await login(page, 'warehouse');
    await expect(page.locator('.app-page-title')).toHaveText('הזמנות');
  });

  test('agent lands on the orders list', async ({ page }) => {
    await login(page, 'agent1');
    await expect(page.locator('.app-page-title')).toHaveText('הזמנות');
  });

  test('wrong password shows an error and does not log in', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('שם משתמש').fill('manager');
    await page.getByPlaceholder('סיסמה').fill('wrong-password');
    await page.getByRole('button', { name: /כניסה/ }).click();
    await expect(page.locator('.error-box')).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);
  });
});
