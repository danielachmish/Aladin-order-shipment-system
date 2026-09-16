async function login(page, username, password = '1234') {
  await page.goto('/');
  await page.getByPlaceholder('שם משתמש').fill(username);
  await page.getByPlaceholder('סיסמה').fill(password);
  await page.getByRole('button', { name: /כניסה/ }).click();
  await page.waitForSelector('.app-shell');
}

async function openOrder(page, orderNum) {
  await page.getByPlaceholder(/חיפוש/).fill(String(orderNum));
  await page.locator('.order-card', { hasText: `הזמנה ${orderNum}` }).first().click();
  await page.waitForSelector('.detail-header');
}

module.exports = { login, openOrder };
