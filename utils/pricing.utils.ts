import { Locator, Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";

/**
 * Modul Penyesuaian Harga Tiket (dibuat 2026-10-15 atas permintaan user).
 *
 * Cara kerja (mengikuti struktur halaman rute game):
 * 1. Di halaman rute, klik tautan rute ("XXX - YYY") dari penerbangan yang
 *    belum berangkat -> terbuka jendela detail berisi Seat Layout.
 * 2. Klik tombol "Auto" di jendela itu: semua kolom harga terisi harga
 *    auto (saran sistem). Karena selalu mulai dari Auto, operasi ini
 *    IDEMPOTEN - menjalankan ulang tidak pernah menggandakan kenaikan.
 * 3. Baca nilai auto tiap kelas, kalikan: Ekonomi x1.10, Bisnis x1.08,
 *    First x1.06 (dibulatkan ke bawah ke kelipatan 10), isi kembali.
 * 4. Klik Save. Setiap penerbangan dicatat di log: kode, harga auto,
 *    dan harga baru per kelas, agar hasilnya bisa diverifikasi.
 *
 * Modul ini hanya berjalan jika ENABLE_PRICING=true. Jumlah penerbangan
 * per run dibatasi PRICING_MAX_UPDATES (default 3) dan ada batas waktu
 * internal agar tidak mengganggu modul lain.
 */
export class PricingUtils {
    page: Page;
    maxUpdates: number;
    deadlineMs: number;
    multEconomy: number;
    multBusiness: number;
    multFirst: number;

    constructor(page: Page) {
        this.page = page;
        this.maxUpdates = parseInt(process.env.PRICING_MAX_UPDATES ?? '3', 10) || 3;
        this.deadlineMs = parseInt(process.env.PRICING_DEADLINE_MS ?? '100000', 10) || 100000;
        this.multEconomy = parseFloat(process.env.PRICING_ECO_MULTIPLIER ?? '1.10') || 1.10;
        this.multBusiness = parseFloat(process.env.PRICING_BUSINESS_MULTIPLIER ?? '1.08') || 1.08;
        this.multFirst = parseFloat(process.env.PRICING_FIRST_MULTIPLIER ?? '1.06') || 1.06;
    }

    private async waitForRoutesPageReady(timeoutMs = 10000): Promise<boolean> {
        try {
            await this.page.getByText(/Cost index/i).first().waitFor({ state: 'visible', timeout: timeoutMs });
            return true;
        } catch {
            console.log('[Pricing] Routes page readiness timed out.');
            return false;
        }
    }

    private async closeDetail(flightCode: string): Promise<void> {
        const closeBtn = this.page.locator('.modal-header .close, .box-header .close, button.close').first();
        if (await closeBtn.isVisible().catch(() => false)) {
            await closeBtn.click().catch(() => {});
            await GeneralUtils.randomSleep(500, 1000);
            return;
        }
        await this.page.keyboard.press('Escape').catch(() => {});
        await GeneralUtils.randomSleep(500, 1000);
        console.log(`[Pricing] ${flightCode}: detail closed via fallback (Escape).`);
    }

    public async updatePrices(): Promise<void> {
        console.log(`[Pricing] Start. Cap ${this.maxUpdates} flight(s), multipliers Y x${this.multEconomy} / J x${this.multBusiness} / F x${this.multFirst}.`);

        if (!await this.waitForRoutesPageReady()) {
            console.log('[Pricing] Routes page not ready - skipping pricing this run.');
            return;
        }

        const deadline = Date.now() + this.deadlineMs;

        const routeLinks = this.page.locator('a:visible, button:visible, [role="link"]:visible').filter({ hasText: /.+ - .+/ });
        const count = await routeLinks.count().catch(() => 0);
        console.log(`[Pricing] Found ${count} potential route links.`);

        let updated = 0;
        let inspected = 0;

        for (let index = 0; index < count; index++) {
            if (updated >= this.maxUpdates) {
                console.log(`[Pricing] Reached cap of ${this.maxUpdates} updated flight(s).`);
                break;
            }
            if (Date.now() > deadline) {
                console.log('[Pricing] Internal deadline reached - stopping.');
                break;
            }

            const link = routeLinks.nth(index);
            if (!(await link.isVisible().catch(() => false))) {
                continue;
            }

            const linkText = (await link.innerText().catch(() => '')).trim();
            if (/^(next|prev|previous)$/i.test(linkText) || /^\d+$/.test(linkText)) {
                continue;
            }

            const rowText = await link.evaluate((el: HTMLElement) => {
                let curr: HTMLElement | null = el.parentElement;
                for (let i = 0; i < 6 && curr; i++) {
                    if (curr.innerText && (/#/.test(curr.innerText) || /depart|demand/i.test(curr.innerText))) {
                        return curr.innerText;
                    }
                    curr = curr.parentElement;
                }
                return '';
            }).catch(() => '');

            const codeMatch = rowText.match(/#([A-Z0-9-]+)/i);
            const flightCode = codeMatch ? codeMatch[1] : linkText;

            if (/departed|airborne|arrived/i.test(rowText)) {
                continue;
            }

            inspected++;
            console.log(`[Pricing] Inspecting ${flightCode} (${linkText})...`);

            try {
                await GeneralUtils.moveAndClick(this.page, link);

                const modalReady = await Promise.any([
                    this.page.getByText(/seat layout/i).first().waitFor({ state: 'visible', timeout: 10000 }),
                    this.page.locator('button, .btn, [role="button"]').filter({ hasText: /^auto([^a-z]|$)/i }).first().waitFor({ state: 'visible', timeout: 10000 }),
                    this.page.locator('.modal-header, .box-header').first().waitFor({ state: 'visible', timeout: 10000 })
                ]).then(() => true).catch(() => false);

                if (!modalReady) {
                    console.log(`[Pricing] ${flightCode}: detail view did not open - skipped.`);
                    await this.closeDetail(flightCode);
                    continue;
                }

                const autoButton = this.page.locator('button, .btn, [role="button"]').filter({ hasText: /^auto([^a-z]|$)/i }).first();

                if (!(await autoButton.isVisible().catch(() => false))) {
                    const seatHeader = this.page.getByText(/seat layout/i).first();
                    if (await seatHeader.isVisible().catch(() => false)) {
                        await seatHeader.click({ timeout: 3000, force: true }).catch(() => {});
                        await GeneralUtils.randomSleep(500, 1000);
                    }
                }

                if (!(await autoButton.isVisible().catch(() => false))) {
                    console.log(`[Pricing] ${flightCode}: Auto button not found - skipped.`);
                    await this.closeDetail(flightCode);
                    continue;
                }

                // Klik Auto -> kolom harga terisi harga auto sistem.
                await GeneralUtils.moveAndClick(this.page, autoButton);
                await GeneralUtils.randomSleep(1000, 1500);

                const visibleInputs = this.page.locator('.modal:visible input:visible');
                const inputCount = await visibleInputs.count().catch(() => 0);

                const classInputs: { locator: Locator; label: string; multiplier: number }[] = [];
                for (let j = 0; j < inputCount; j++) {
                    const inputLocator = visibleInputs.nth(j);
                    const detected = await inputLocator.evaluate((el) => {
                        const row = el.closest('tr, .row, .input-group') as HTMLElement | null;
                        const text = (row?.innerText || '').toLowerCase();
                        if (text.includes('eco')) return 'economy';
                        if (text.includes('bus')) return 'business';
                        if (text.includes('fir')) return 'first';
                        return '';
                    }).catch(() => '');

                    if (detected === 'economy') classInputs.push({ locator: inputLocator, label: 'economy', multiplier: this.multEconomy });
                    else if (detected === 'business') classInputs.push({ locator: inputLocator, label: 'business', multiplier: this.multBusiness });
                    else if (detected === 'first') classInputs.push({ locator: inputLocator, label: 'first', multiplier: this.multFirst });
                }

                if (classInputs.length === 0) {
                    console.log(`[Pricing] ${flightCode}: no labelled price inputs found (${inputCount} inputs in modal) - skipped.`);
                    await this.closeDetail(flightCode);
                    continue;
                }

                let changedAny = false;
                const details: string[] = [];

                for (const item of classInputs) {
                    const raw = await item.locator.inputValue({ timeout: 2000 }).catch(() => '');
                    const autoPrice = parseInt(raw.replace(/[^0-9]/g, ''), 10) || 0;
                    if (autoPrice <= 0) {
                        console.log(`[Pricing] ${flightCode} ${item.label}: could not read auto price (raw "${raw}") - skipped class.`);
                        continue;
                    }
                    const target = Math.max(10, Math.floor((autoPrice * item.multiplier) / 10) * 10);
                    details.push(`${item.label} auto ${autoPrice} -> ${target}`);
                    if (target !== autoPrice) {
                        await item.locator.click({ timeout: 2000, force: true }).catch(() => {});
                        await item.locator.press('Control+a').catch(() => {});
                        await item.locator.fill(target.toString(), { timeout: 2000 });
                        changedAny = true;
                    }
                }

                if (!changedAny) {
                    console.log(`[Pricing] ${flightCode}: prices already at target (${details.join('; ')}) - no save.`);
                    await this.closeDetail(flightCode);
                    continue;
                }

                const saveButton = this.page.getByRole('button', { name: /^save$/i }).first();
                if (!(await saveButton.isVisible().catch(() => false))) {
                    console.log(`[Pricing] ${flightCode}: Save button not visible - NOT saved. Values were: ${details.join('; ')}`);
                    await this.closeDetail(flightCode);
                    continue;
                }

                await GeneralUtils.moveAndClick(this.page, saveButton);
                await GeneralUtils.randomSleep(800, 1500);
                updated++;
                console.log(`[Pricing] ${flightCode}: SAVED. ${details.join('; ')}`);

                await this.closeDetail(flightCode);
            } catch (error) {
                console.log(`[Pricing] ${flightCode}: error during update - ${(error as Error).message}`);
                await this.closeDetail(flightCode).catch(() => {});
            }
        }

        console.log(`[Pricing] Done. Updated ${updated} flight(s), inspected ${inspected}, cap ${this.maxUpdates}.`);
    }
}
