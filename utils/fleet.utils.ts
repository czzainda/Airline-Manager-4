import { Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";

export class FleetUtils {
    page : Page;
    maxTry : number;

    constructor(page : Page) {
        this.page = page;
        this.maxTry = 20;
    }

    /**
     * Menyimulasi pergerakan kursor mouse yang halus dari posisi saat ini ke koordinat target.
     * Mencegah kursor melompat instan dengan memberikan efek kurva/noise mikro.
     */
    private async humanMouseMove(targetX: number, targetY: number) {
        const steps = Math.floor(Math.random() * 5) + 5; // 5-10 langkah pergerakan kursor
        let currentX = targetX + (Math.random() * 200 - 100);
        let currentY = targetY + (Math.random() * 200 - 100);

        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const noiseX = (Math.random() - 0.5) * 5;
            const noiseY = (Math.random() - 0.5) * 5;
            
            const x = currentX + (targetX - currentX) * t + noiseX;
            const y = currentY + (targetY - currentY) * t + noiseY;

            await this.page.mouse.move(x, y);
            await this.page.waitForTimeout(Math.floor(Math.random() * 20) + 10);
        }
        await this.page.mouse.move(targetX, targetY);
    }

    /**
     * Helper privat untuk menggerakkan mouse ke elemen target secara acak di dalam area kotak,
     * lalu melakukan klik fisik manusiawi (tidak konstan di tengah box).
     */
    private async moveAndClick(locator: any) {
        const box = await locator.boundingBox();
        if (box) {
            const paddingX = box.width * 0.15;
            const paddingY = box.height * 0.15;

            // Mengacak titik tujuan di dalam area aman kotak tombol
            const randomX = box.x + paddingX + (Math.random() * (box.width - (paddingX * 2)));
            const randomY = box.y + paddingY + (Math.random() * (box.height - (paddingY * 2)));

            await this.humanMouseMove(randomX, randomY);
            await GeneralUtils.randomSleep(200, 500); // Jeda sesaat setelah mouse mendarat
        }
        await GeneralUtils.humanClick(this.page, locator);
    }

    public async departPlanes(reopenPanel?: () => Promise<void>) {
        console.log('Looking if there are any planes to be departed...');

        // 2026-10-25 fix: the old version sampled #departAll with a single
        // instant isVisible(). If the fleet list was still rendering, it saw
        // "no button" and finished with 0 departures in a green run
        // (run 40171570235: check and finish logged in the same millisecond,
        // 0 Departing lines). Now the button is waited for, absence must
        // persist across a window, a confirmation pass re-checks, and a
        // genuinely stuck depart throws so the run fails loudly.
        // 2026-10-28: if the button never appears at all, the panel is
        // closed and re-opened once via the caller's reopenPanel callback;
        // if it still never appears, the module throws (red run) instead
        // of passing green with 0 departures (run 40804442150).
        const departAll = this.page.locator('#departAll');
        const buttonAppears = async (timeoutMs: number): Promise<boolean> => {
            return await departAll.waitFor({ state: 'visible', timeout: timeoutMs })
                .then(() => true)
                .catch(() => false);
        };

        let totalClicks = 0;
        let buttonEverAppeared = false;
        let toastSeen = false;
        let cleanPass = false;
        let reopened = false;

        for (let pass = 1; pass <= 3 && !cleanPass; pass++) {
            let present = await buttonAppears(pass === 1 ? 30000 : 15000);
            if (present)
                buttonEverAppeared = true;

            let passClicks = 0;
            while (present && passClicks < this.maxTry) {
                console.log('Departing 20 or less...');

                // Tunggu respons API rute penerbangan asli selesai diproses jaringan,
                // dikombinasikan dengan fungsi moveAndClick yang meluncur halus secara acak.
                await Promise.all([
                    this.page.waitForResponse(response =>
                        response.url().includes('route') && response.status() === 200,
                        { timeout: 10000 }
                    ).catch(() => console.log('Timeout waiting for API, doing fallback sleep')),
                    this.moveAndClick(departAll)
                ]);

                totalClicks++;
                passClicks++;

                // Tambahkan jeda santai manusia pasca-klik (proses berpikir/animasi)
                await GeneralUtils.randomSleep(1500, 3000);

                const cantDepartPlane = await this.page.getByText('\u00d7Unable to departSome A/C was').isVisible();
                if (cantDepartPlane) {
                    toastSeen = true;
                    console.log('[Depart] Game showed the "Unable to depart" toast; ending this pass.');
                    break;
                }

                // Absence must persist for a full 10s window before it counts;
                // a momentary flicker while the list refreshes is not "done".
                present = await buttonAppears(10000);
                if (present)
                    buttonEverAppeared = true;
            }
            console.log(`[Depart] Pass ${pass}: ${passClicks} batch(es) departed.`);

            if (toastSeen)
                break;

            if (!present && passClicks === 0 && totalClicks === 0 && !buttonEverAppeared) {
                // The button never showed up at all: the depart panel may
                // never have opened. Re-open it once and sweep again before
                // concluding anything.
                if (reopenPanel && !reopened) {
                    reopened = true;
                    console.log('[Depart] departAll never appeared; re-opening the depart panel and trying again...');
                    await reopenPanel().catch(() => null);
                    continue;
                }
                break;
            }

            if (!present && (passClicks === 0 || pass >= 2))
                cleanPass = true;

            if (!cleanPass && pass < 3)
                await GeneralUtils.randomSleep(3000, 5000);
        }

        const endVisible = await buttonAppears(3000);
        console.log(`[Depart] Summary: ${totalClicks} batch(es) departed in total; departAll visible at end: ${endVisible}; unable-to-depart toast seen: ${toastSeen}.`);
        console.log('Departed operations finished.');

        if (!buttonEverAppeared && totalClicks === 0)
            console.log('[Depart] WARNING: departAll never appeared in any pass (depart panel may not have opened, or no planes were ready).');

        if (!buttonEverAppeared && totalClicks === 0)
            throw new Error('[Depart] departAll never appeared, even after re-opening the panel; failing loudly instead of passing with 0 departures.');

        if (endVisible && !toastSeen && !cleanPass)
            throw new Error('[Depart] departAll still visible after all passes; planes were likely left behind.');
    }
}
