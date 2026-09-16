const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // כל קובץ בדיקה מקבל DB_PATH ייחודי משלו (ר' tests/helpers/testApp.js) —
    // isolate:true (ברירת המחדל) מבטיח שכל קובץ מריץ את מודולי ה-DB מחדש.
    isolate: true,
    testTimeout: 15000,
  },
});
