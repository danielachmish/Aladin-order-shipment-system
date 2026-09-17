const { test, expect } = require('@playwright/test');
const { login, openOrder } = require('./helpers');

// קישור הזמנות ואכיפת אריזה משותפת (ר' ייעוץ 16-17.9.2026, נושא 1) - משתמש
// בהזמנות הדמו 54712 ו-54720 (backend/src/sigmaBridgeMock.js), לא קשורות
// זו לזו במקור. מריץ נגד frontend+backend אמיתיים.
test('linking two orders shows the badge, and packing ahead of a lagging sibling is blocked', async ({ page }) => {
  await login(page, 'warehouse');

  await openOrder(page, 54712);
  await page.getByRole('button', { name: '🔗 קשר להזמנה אחרת' }).click();
  await page.locator('.modal-sheet input[type="text"]').fill('54720');
  await page.locator('.modal-sheet').getByText('הזמנה 54720').first().click();
  await expect(page.getByText(/מקושרת ל/)).toBeVisible();

  // הבאדג' מופיע גם ברשימה הראשית, לא רק בתוך פרטי ההזמנה
  await page.getByRole('button', { name: '→ חזרה לרשימה' }).click();
  await page.getByPlaceholder(/חיפוש/).fill('54712');
  await expect(page.locator('.order-card', { hasText: 'הזמנה 54712' }).getByText('🔗 מקושרת')).toBeVisible();

  // מקדמים את 54712 עד סוף הבדיקה, בזמן ש-54720 (האחות) נשארת בתור - לא נוגעים בה בכוונה
  await openOrder(page, 54712);
  await page.getByRole('button', { name: 'התחלת ליקוט' }).click();
  await expect(page.locator('.badge.status-picking')).toBeVisible();
  const pickButtons = page.getByRole('button', { name: '✓ ליקטתי הכל' }); // 2 שורות בהזמנת הדמו 54712
  const pickCount = await pickButtons.count();
  for (let i = 0; i < pickCount; i++) {
    await pickButtons.nth(i).click();
    await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: /^סיום ליקוט/ }).click();
  for (const _ of [1, 2]) {
    await page.getByRole('button', { name: '✓ מאשר' }).first().click();
    await page.waitForTimeout(150);
  }

  // ברגע "סיום בדיקה" צריך לצאת חלון בתוך האפליקציה (לא window.alert של
  // הדפדפן - ר' בקשת דניאל 17.9.2026) שההזמנה המקושרת עוד לא הגיעה לשלב
  await page.getByRole('button', { name: /^אישרתי בדיקה/ }).click();
  await expect(page.getByText('⚠️ הזמנה מקושרת עדיין לא מוכנה')).toBeVisible();
  await expect(page.locator('.modal-sheet')).toContainText('54720');
  await page.getByRole('button', { name: 'הבנתי' }).click();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await expect(page.locator('.badge.status-ready_to_pack')).toBeVisible();

  // ניסיון לסיים אריזה נחסם בשרת (guard), עם שגיאה שמזכירה את ההזמנה השנייה.
  // ממתינים לתשובת ה-API עצמה (לא רק לרינדור) כדי שהבדיקה לא תהיה תלויה בטיימינג
  // של רינדור React אחרי ה-reload הפנימי של act().
  await page.getByRole('button', { name: 'סיום אריזה' }).click();
  const [packResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/pack-done') && res.request().method() === 'POST'),
    page.getByRole('button', { name: 'סיום אריזה' }).last().click(),
  ]);
  expect(packResponse.status()).toBe(400);
  const packBody = await packResponse.json();
  expect(packBody.error).toContain('54720');

  await expect(page.locator('.error-box')).toContainText('54720');
  await expect(page.locator('.badge.status-ready_to_pack')).toBeVisible(); // עדיין לא זזה
});
