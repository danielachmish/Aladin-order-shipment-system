const { test, expect } = require('@playwright/test');
const { login, openOrder } = require('./helpers');

// "⚙️ הגדרות הזמנה" — ר' ייעוץ 17.9.2026: מנהל יכול להגדיר גוביינא/משלוח
// מתוכנן/הערה/עדיפות מוקדם, ישר מהרשימה הראשית, לא רק אחרי שההזמנה עברה
// להיסטוריה - ולראות badges על הכרטיס בלי לפתוח את ההזמנה.
test('manager can set order settings from the list, and see badges on the card', async ({ page }) => {
  await login(page, 'manager');
  await page.getByRole('button', { name: 'הזמנות' }).click();
  await page.getByPlaceholder(/חיפוש/).fill('54720');

  const card = page.locator('.order-card', { hasText: 'הזמנה 54720' });
  await card.getByTitle('הגדרות הזמנה').click();

  await expect(page.getByText('⚙️ הגדרות הזמנה 54720')).toBeVisible();
  await page.locator('.modal-sheet select').nth(1).selectOption('ups'); // אופן משלוח מתוכנן
  await page.locator('.modal-sheet select').nth(2).selectOption('full'); // גוביינא
  await page.locator('.modal-sheet input[type="date"]').fill('2026-10-15');
  await page.locator('.modal-sheet textarea').fill('לא להוציא לפני תשלום');
  await page.getByRole('button', { name: 'שמירה' }).click();

  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await expect(card.getByText('🚚 UPS')).toBeVisible();
  await expect(card.getByText(/💰/)).toBeVisible();
  await expect(card.getByText('📝 לא להוציא לפני תשלום')).toBeVisible();

  // אותו מידע זמין גם מתוך פרטי ההזמנה עצמה
  await card.click();
  await expect(page.getByText(/גוביינא/)).toBeVisible();
  await expect(page.getByText('📝 לא להוציא לפני תשלום')).toBeVisible();
});
