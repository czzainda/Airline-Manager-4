import { defineConfig, devices } from '@playwright/test';

// Separate config for the one-shot read-only recon spec so neither the
// main bot workflow (testDir ./tests) nor the snapshot workflow
// (testDir ./snapshot) ever picks it up.
export default defineConfig({
    testDir: './recon',
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
