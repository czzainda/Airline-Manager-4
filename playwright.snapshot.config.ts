import { defineConfig, devices } from '@playwright/test';

// Separate config for the read-only fleet snapshot collector so the
// main bot workflow (playwright.config.ts, testDir ./tests) never picks
// the snapshot spec up, and vice versa.
export default defineConfig({
    testDir: './snapshot',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 1,
    reporter: 'list',
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
