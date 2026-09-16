// בדיקות E2E מקצה-לקצה (ר' ייעוץ 16-17.9.2026, נושא 8) — מריצות backend+frontend
// אמיתיים (לא mock/unit) מול DB זמני נפרד (DB_PATH), כדי לבדוק את המערכת
// כמו שמשתמש אמיתי חווה אותה, בלי לגעת ב-aladin.db של הפיתוח המקומי.
// דורש את פורטי הפיתוח הרגילים (4310/5173) פנויים בזמן ההרצה.
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { defineConfig, devices } = require('@playwright/test');

const dbPath = path.join(os.tmpdir(), `aladin-e2e-${crypto.randomBytes(6).toString('hex')}.db`);

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false, // אותו DB משותף בין הקבצים - להריץ בטור כדי לא להתנגש
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node src/server.js',
      cwd: path.join(__dirname, '..', 'backend'),
      port: 4310,
      timeout: 30000,
      reuseExistingServer: false,
      env: {
        DB_PATH: dbPath,
        JWT_SECRET: 'e2e-test-secret',
        PORT: '4310',
      },
    },
    {
      command: 'npx vite --port 5173',
      cwd: path.join(__dirname, '..', 'frontend'),
      port: 5173,
      timeout: 30000,
      reuseExistingServer: false,
    },
  ],
});
