const { test, expect } = require('@playwright/test');
const { login, openOrder } = require('./helpers');

// תיקון (17.9.2026, בקשת דניאל): כפתור "חזור" בדפדפן/בטלפון היה יוצא מהאתר
// לגמרי במקום לחזור שלב אחד אחורה בתוך האפליקציה, כי הניווט מעולם לא נרשם
// ב-history של הדפדפן. עכשיו כל שינוי טאב/פתיחת הזמנה דוחף רשומת history.
test.describe('back button stays inside the app', () => {
  test('going back from an open order returns to the orders list, not out of the app', async ({ page }) => {
    await login(page, 'warehouse');
    await expect(page.locator('.app-page-title')).toHaveText('הזמנות');

    await openOrder(page, 54707);
    await expect(page.locator('.detail-header')).toBeVisible();

    await page.goBack();
    await expect(page.locator('.app-page-title')).toHaveText('הזמנות');
    await expect(page.locator('.detail-header')).toHaveCount(0);
  });

  test('going back after switching tabs returns to the previous tab', async ({ page }) => {
    await login(page, 'manager');
    await expect(page.locator('.app-page-title')).toHaveText('דשבורד');

    await page.getByRole('button', { name: 'חוסרי מלאי' }).click();
    await expect(page.locator('.app-page-title')).toHaveText('חוסרי מלאי');

    await page.goBack();
    await expect(page.locator('.app-page-title')).toHaveText('דשבורד');
  });
});
