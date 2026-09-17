const { test, expect } = require('@playwright/test');
const { login, openOrder } = require('./helpers');

// זרימה מלאה: הזמנה 54707 (נתוני דמו קבועים, ר' backend/src/sigmaBridgeMock.js) -
// המתנה לליקוט -> ליקוט -> בדיקה -> אריזה (עם ספירת חבילות) -> מסירה ל-UPS -> סגירה.
// מריץ נגד frontend+backend אמיתיים כמשתמש warehouse אמיתי, לא mock.
test('full order lifecycle: claim through close', async ({ page }) => {
  await login(page, 'warehouse');
  await openOrder(page, 54707);

  await expect(page.locator('.badge.status-waiting_pick')).toBeVisible();
  await page.getByRole('button', { name: 'התחלת ליקוט' }).click();
  await expect(page.locator('.badge.status-picking')).toBeVisible();

  // ליקוט: מסמנים "ליקטתי הכל" על כל שורה (4 פריטים בהזמנת הדמו). אחרי
  // סימון, הכפתור מוחלף ב"תיקון" (בקשת דניאל 17.9.2026 — תמיד אפשר לחזור
  // ולתקן) — אז הרשימה מתכווצת בכל לחיצה, וחייבים .first() חוזר, לא nth(i) קבוע.
  const pickCount = await page.getByRole('button', { name: '✓ ליקטתי הכל' }).count();
  expect(pickCount).toBe(4);
  for (let i = 0; i < pickCount; i++) {
    await page.getByRole('button', { name: '✓ ליקטתי הכל' }).first().click();
    await page.waitForTimeout(150); // מחכים לרענון הרשימה בין לחיצות
  }

  await page.getByRole('button', { name: /^סיום ליקוט/ }).click();
  await expect(page.locator('.badge.status-ready_for_check')).toBeVisible();

  // בדיקה: מאשרים כל שורה
  const checkButtons = page.getByRole('button', { name: '✓ מאשר' });
  const checkCount = await checkButtons.count();
  expect(checkCount).toBe(4);
  for (let i = 0; i < checkCount; i++) {
    await page.getByRole('button', { name: '✓ מאשר' }).first().click();
    await page.waitForTimeout(150);
  }

  await page.getByRole('button', { name: /^אישרתי בדיקה/ }).click();
  await expect(page.locator('.badge.status-ready_to_pack')).toBeVisible();

  // אריזה: נפתח חלון ספירת חבילות/משטחים
  await page.getByRole('button', { name: 'סיום אריזה' }).click();
  await expect(page.getByText('כמה יצא בפועל?')).toBeVisible();
  await page.locator('.modal-sheet input[type="number"]').first().fill('2'); // חבילות
  await page.getByRole('button', { name: 'סיום אריזה' }).last().click();
  await expect(page.locator('.badge.status-waiting_pickup')).toBeVisible();

  await page.getByRole('button', { name: 'מסירה ל-UPS' }).click();
  await expect(page.locator('.badge.status-delivered_to_ups')).toBeVisible();

  await page.getByRole('button', { name: /^סגירת הזמנה/ }).click();
  await expect(page.locator('.badge.status-closed')).toBeVisible();
});
