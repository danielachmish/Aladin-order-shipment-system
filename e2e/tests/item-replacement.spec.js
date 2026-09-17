const { test, expect } = require('@playwright/test');
const { login, openOrder } = require('./helpers');

// "הוחלף צבע" — הלקוח אישר תחליף (SKU/צבע אחר, אותו מחיר) לפריט חסר, עם
// כמות מפורשת. זמין גם למלקט (ברגע שמסמן חסר) וגם לבודק — לא רק למנהל
// בהיסטוריה אחר כך. תחליף שהמלקט הזין בשלב הליקוט נשאר "ממתין לאימות בודק"
// עד שהבודק בפועל מאשר אותו. ר' בקשת דניאל 17.9.2026. משתמש בהזמנת דמו
// 54731 (3 שורות, לא נוגעת בהזמנות שבדיקות אחרות מסתמכות עליהן).
test('picker records a replacement (pending), checker verifies and confirms it', async ({ page }) => {
  await login(page, 'warehouse');
  await openOrder(page, 54731);

  await page.getByRole('button', { name: 'התחלת ליקוט' }).click();
  await expect(page.locator('.badge.status-picking')).toBeVisible();

  const shortItemCard = page.locator('.pick-item-card', { hasText: 'כן למסך' });
  await shortItemCard.getByRole('button', { name: 'כמות אחרת / חסר' }).click();
  await shortItemCard.getByRole('button', { name: 'לא נמצא בכלל' }).click();
  await expect(shortItemCard.getByText('❌ לא נמצא')).toBeVisible();

  // המלקט מתעד תחליף — הכמות כבר ממולאת מראש (כל הכמות שהוזמנה, 4), רק הפריט צריך מילוי
  await shortItemCard.getByRole('button', { name: '🔄 הוחלף צבע' }).click();
  await shortItemCard.getByPlaceholder('לאיזה צבע/פריט הוחלף?').fill('אדום');
  await shortItemCard.getByRole('button', { name: 'שמירה' }).click();
  await expect(shortItemCard.getByText('🔄 4 יח\' אדום · ממתין לאימות בודק')).toBeVisible();

  // שתי השורות האחרות נלקטות רגיל כדי לאפשר סיום ליקוט (הכפתורים נשארים
  // מוצגים גם אחרי שסומן חסר, אז חייבים לבחור לפי שם השורה, לא ספירה גלובלית)
  await page.locator('.pick-item-card', { hasText: 'מסך 24 אינץ׳' }).getByRole('button', { name: '✓ ליקטתי הכל' }).click();
  await page.waitForTimeout(150);
  await page.locator('.pick-item-card', { hasText: 'מקלדת אלחוטית' }).getByRole('button', { name: '✓ ליקטתי הכל' }).click();
  await page.waitForTimeout(150);

  await page.getByRole('button', { name: /^סיום ליקוט/ }).click();
  await expect(page.locator('.badge.status-ready_for_check')).toBeVisible();

  // התחליף של המלקט עדיין מוצג כממתין, עם כפתור אישור לבודק
  const checkedItemCard = page.locator('.pick-item-card', { hasText: 'כן למסך' });
  await expect(checkedItemCard.getByText('🔄 4 יח\' אדום · ממתין לאימות בודק')).toBeVisible();
  await checkedItemCard.getByRole('button', { name: '✓ אשר תחליף' }).click();
  await expect(checkedItemCard.getByText('🔄 4 יח\' אדום · מאומת')).toBeVisible();
  await expect(checkedItemCard.getByRole('button', { name: '✓ אשר תחליף' })).toHaveCount(0);
});
