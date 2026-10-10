import { Page } from "@playwright/test";

require('dotenv').config();

export class GeneralUtils {
    username : string;
    password : string;
    page : Page;

    constructor(page : Page) {
        this.username = process.env.EMAIL!;
        this.password = process.env.PASSWORD!;
        this.page = page;
    }

    public static async sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public static async randomSleep(min: number, max: number) {
        const ms = Math.floor(Math.random() * (max - min + 1) + min);
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 🚀 PUSAT SIMULASI MOUSE MANUSIA (GLOBAL)
     */
    public static async humanMouseMove(page: Page, targetX: number, targetY: number) {
        const steps = Math.floor(Math.random() * 5) + 6; 
        let currentX = targetX + (Math.random() * 200 - 100);
        let currentY = targetY + (Math.random() * 200 - 100);

        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const noiseX = (Math.random() - 0.5) * 5;
            const noiseY = (Math.random() - 0.5) * 5;
            
            const x = currentX + (targetX - currentX) * t + noiseX;
            const y = currentY + (targetY - currentY) * t + noiseY;

            await page.mouse.move(x, y);
            await page.waitForTimeout(Math.floor(Math.random() * 15) + 10);
        }
        await page.mouse.move(targetX, targetY);
    }

    /**
     * 🚀 PUSAT SELEKSI KLIK MANUSIA (GLOBAL)
     * Ditambahkan customTimeout opsional agar elemen pertama bisa menunggu lebih lama tanpa merubah global timeout elemen lain.
     */
    public static async moveAndClick(page: Page, locator: any, customTimeout = 10000) {
        // Menggunakan customTimeout jika dipasing, jika tidak kembali ke default 10 detik
        await locator.waitFor({ state: 'visible', timeout: customTimeout });
        const box = await locator.boundingBox();
        
        if (box) {
            const paddingX = box.width * 0.15;
            const paddingY = box.height * 0.15;

            const randomX = box.x + paddingX + (Math.random() * (box.width - (paddingX * 2)));
            const randomY = box.y + paddingY + (Math.random() * (box.height - (paddingY * 2)));

            await this.humanMouseMove(page, randomX, randomY);
            await this.randomSleep(200, 500); 

            await page.mouse.down();
            await this.randomSleep(80, 220); 
            await page.mouse.up();
        } else {
            await locator.click();
        }
    }

    public static async humanClick(page: Page, selectorOrLocator: any) {
        const locator = typeof selectorOrLocator === 'string' ? page.locator(selectorOrLocator) : selectorOrLocator;
        await this.moveAndClick(page, locator);
    }

    public async login(page: Page) {
        console.log('Logging in with enhanced keystroke and mouse dynamics...')

        await page.goto('https://www.airlinemanager.com/');
        
        // 🚀 OPTIMALISASI 1: Daripada tidur kaku 5 detik, kita suruh Playwright menunggu sampai network idle (aset selesai diunduh)
        // Jika server super cepat, proses ini hanya memakan waktu 1-2 detik saja!
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => console.log("Network belum sepenuhnya idle, lanjut saja..."));

        // 🚀 OPTIMALISASI 2: Kasih timeout 30 detik (30000) KHUSUS untuk tombol "PLAY FREE NOW" karena ini gerbang pertama masuk web
        // Ingat: Playwright tidak akan menunggu sampai 30 detik penuh. Begitu tombolnya muncul di detik ke-3, ia langsung klik! Jadi tidak buang waktu.
        const playFreeButton = page.getByRole('button', { name: 'PLAY FREE NOW' });
        await GeneralUtils.moveAndClick(page, playFreeButton, 30000); 
        await GeneralUtils.randomSleep(1000, 2000);

        // Kasih timeout lebih panjang untuk pemuatan modal login.
        // FIX 2026-10-10: langkah ini berjalan SEBELUM kredensial diisi, jadi
        // kegagalan di sini murni soal kecepatan muat halaman, bukan konflik sesi.
        // Timeout lama 15 detik terlalu pendek untuk transisi berat setelah
        // PLAY FREE NOW: naikkan ke 45 detik; jika tetap gagal, reload halaman
        // dan coba sekali lagi.
        const loginMenuButton = page.getByRole('button', { name: 'Log in' });
        try {
            await GeneralUtils.moveAndClick(page, loginMenuButton, 45000);
        } catch (error) {
            console.log('Log in button not visible within 45s - reloading page and retrying once...');
            await page.reload({ waitUntil: 'load' }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => console.log("Network belum sepenuhnya idle setelah reload, lanjut saja..."));

            // Jika setelah reload kita kembali ke landing page, klik PLAY FREE NOW lagi.
            const playFreeAgain = page.getByRole('button', { name: 'PLAY FREE NOW' });
            const backAtLanding = await playFreeAgain.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
            if (backAtLanding) {
                await GeneralUtils.moveAndClick(page, playFreeAgain, 30000);
                await GeneralUtils.randomSleep(1000, 2000);
            }

            await GeneralUtils.moveAndClick(page, loginMenuButton, 45000);
            console.log('Log in button appeared after reload retry.');
        }
        await GeneralUtils.randomSleep(1000, 2000);

        // --- Proses Pengisian Email ---
        const emailInput = page.locator('#lEmail');
        await GeneralUtils.moveAndClick(page, emailInput);
        await GeneralUtils.randomSleep(400, 800);
        await emailInput.pressSequentially(this.username, { delay: Math.floor(Math.random() * 80) + 40 });
        await GeneralUtils.randomSleep(500, 1200);
        
        // --- Proses Pengisian Password ---
        const passwordInput = page.locator('#lPass');
        await GeneralUtils.moveAndClick(page, passwordInput);
        await GeneralUtils.randomSleep(400, 800);
        await passwordInput.pressSequentially(this.password, { delay: Math.floor(Math.random() * 80) + 40 });
        await GeneralUtils.randomSleep(1000, 2000); 

        // Gerakkan mouse melengkung dan klik tombol submit "Log In" final
        const submitLoginButton = page.getByRole('button', { name: 'Log In', exact: true });
        await GeneralUtils.moveAndClick(page, submitLoginButton);
        
        console.log('Logged in successfully!');
    }
}
