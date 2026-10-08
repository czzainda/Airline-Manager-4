import { Page } from "@playwright/test";
import { GeneralUtils } from "./general.utils";

require('dotenv').config();

export class FuelUtils {
    maxFuelPrice : number;
    maxCo2Price : number;
    page : Page;

    constructor(page : Page) {
        this.maxFuelPrice = parseInt(process.env.MAX_FUEL_PRICE!);
        this.maxCo2Price = parseInt(process.env.MAX_CO2_PRICE!);
        this.page = page;

        console.log("Max Fuel Price: " + this.maxFuelPrice);
        console.log("Max Co2 Price: " + this.maxCo2Price);
    }

    /**
     * Menyimulasi pergerakan kursor mouse yang halus dari posisi saat ini ke koordinat target.
     * Mencegah kursor melompat instan ala robot dengan memberikan efek kurva/noise mikro.
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
     * lalu melakukan humanClick. Manusia tidak pernah mengklik tepat di tengah elemen secara konstan.
     */
    private async moveAndClick(locator: any) {
        const box = await locator.boundingBox();
        if (box) {
            // --- TRIK ACAK KOORDINAT (HUMAN RANDOMIZATION) ---
            // Kita beri batas aman padding 15% dari tepi kotak agar klik tidak meleset ke luar tombol
            const paddingX = box.width * 0.15;
            const paddingY = box.height * 0.15;

            // Mengacak titik tujuan di dalam area aman kotak tombol/input
            const randomX = box.x + paddingX + (Math.random() * (box.width - (paddingX * 2)));
            const randomY = box.y + paddingY + (Math.random() * (box.height - (paddingY * 2)));

            // Arahkan kursor menuju titik acak tersebut dengan lintasan halus
            await this.humanMouseMove(randomX, randomY);
            await GeneralUtils.randomSleep(200, 500); // Jeda sesaat setelah mouse sampai
        }
        await GeneralUtils.humanClick(this.page, locator);
    }

    public async getCurrentBalance() {
        const accountBalanceElement = this.page.locator('#headerAccount');
        if (await accountBalanceElement.count()) {
            const balanceText = await accountBalanceElement.first().innerText().catch(() => '');
            const parsed = parseInt(balanceText.replaceAll(',', '').trim(), 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
                return parsed;
            }
        }

        const accountLabel = this.page.getByText('Account', { exact: true }).first();
        if (await accountLabel.count()) {
            const balanceText = await accountLabel.locator('..').locator('div').first().innerText().catch(() => '');
            const parsed = parseInt(balanceText.replaceAll(',', '').replace(/[^0-9]/g, '').trim(), 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
                return parsed;
            }
        }

        return 0;
    }

    public async buyFuel() {
        console.log('Buying Fuel...')

        const fuelInput = this.page.getByPlaceholder('Amount to purchase');

        const getCurrentFuelPrice = async () => {
            let fuelText = await this.page.getByText('Total price$').locator('b > span').innerText();
            fuelText = fuelText.replaceAll(',', '');
            return parseInt(fuelText);
        }

        const getCurrentFuelUnitPrice = async () => {
            // Gerakkan kursor acak dan klik input box
            await this.moveAndClick(fuelInput);
            await GeneralUtils.randomSleep(500, 1200);

            await fuelInput.press('Control+a');
            await GeneralUtils.randomSleep(400, 900);
            await fuelInput.pressSequentially('1000', { delay: Math.floor(Math.random() * 80) + 40 });
            await GeneralUtils.randomSleep(800, 1400);

            const totalPrice = await getCurrentFuelPrice();
            return totalPrice > 0 ? totalPrice : 0;
        }

        const getCurrentHolding = async () => {
            let holdingText = await this.page.locator('#holding').innerText();
            holdingText = holdingText.replaceAll(',', '');
            return parseInt(holdingText);
        }

        const getEmptyFuel = async () => {
            const emptyText = (await this.page.locator('#remCapacity').innerText()).replaceAll(',', '')
            return parseInt(emptyText);
        }

        const getCurrentBalance = async () => {
            const accountBalanceElement = this.page.locator('#headerAccount');
            try {
                await accountBalanceElement.first().waitFor({ state: 'visible', timeout: 10000 });
            } catch {
                // fallback jika element header account tidak merespon cepat
            }

            if (await accountBalanceElement.count()) {
                const balanceText = await accountBalanceElement.first().innerText().catch(() => '');
                const parsed = parseInt(balanceText.replaceAll(',', '').trim(), 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    return parsed;
                }
            }

            const accountLabel = this.page.getByText('Account', { exact: true }).first();
            if (await accountLabel.count()) {
                const balanceText = await accountLabel.locator('..').locator('div').first().innerText().catch(() => '');
                const parsed = parseInt(balanceText.replaceAll(',', '').replace(/[^0-9]/g, '').trim(), 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    return parsed;
                }
            }

            return 0;
        }

        const currentBalance = await getCurrentBalance();
        console.log('Current Balance: ' + currentBalance);

        const emptyFuel = await getEmptyFuel();
        if(emptyFuel === 0) {
            console.log('Fuel tank is already full.');
            return;
        }

        const unitPrice = await getCurrentFuelUnitPrice();
        const curHolding = await getCurrentHolding();

        console.log('Current Fuel Unit Price (per 1000): ' + unitPrice);
        console.log('Current Balance: ' + currentBalance);

        const calculatePurchaseAmount = (capacity: number, balance: number, pricePer1000Liters: number) => {
            if (pricePer1000Liters <= 0 || balance <= 0) {
                return 0;
            }

            const fullCostForCapacity = (capacity / 1000) * pricePer1000Liters;
            if (balance >= fullCostForCapacity) {
                return capacity;
            }

            const halfBudget = Math.floor(balance / 2);
            const affordableLiters = Math.floor((halfBudget / pricePer1000Liters) * 1000);
            return Math.max(0, Math.min(capacity, affordableLiters));
        }

        const fillFuel = async (amountToBuy: number, label: string) => {
            if (amountToBuy <= 0) {
                console.log('Skipped fuel purchase because computed amount is zero or insufficient balance.');
                return;
            }

            // Gerakkan kursor acak menuju kotak input
            await this.moveAndClick(fuelInput);
            await GeneralUtils.randomSleep(500, 1200);

            await fuelInput.press('Control+a');
            await GeneralUtils.randomSleep(400, 900);

            await fuelInput.pressSequentially(amountToBuy.toString(), { delay: Math.floor(Math.random() * 80) + 40 });
            await GeneralUtils.randomSleep(1000, 2000);

            // Gerakkan kursor acak menuju ke tombol Purchase
            const purchaseButton = this.page.getByRole('button', { name: ' Purchase' });
            await this.moveAndClick(purchaseButton);
            
            console.log(`Bought Fuel Successfully! Amount of fuel bought: ${amountToBuy} Litres${label}`);
        }

        if(unitPrice > 0 && unitPrice < this.maxFuelPrice) {
            const purchaseAmount = calculatePurchaseAmount(emptyFuel, currentBalance, unitPrice);
            await fillFuel(purchaseAmount, '');
        }
        else if(curHolding < 2000000 && unitPrice > 0 && unitPrice < 1250) {
            const suggestedAmount = 2000000;
            const purchaseAmount = calculatePurchaseAmount(suggestedAmount, currentBalance, unitPrice);
            await fillFuel(purchaseAmount, ' (Emergency Buy)');
        } 
    }

    public async buyCo2() {
        console.log('Buying CO2...')

        const purchaseInput = this.page.getByPlaceholder('Amount to purchase');

        const getTotalPrice = async () => {
            let co2Text = await this.page.getByText('Total price$').locator('b > span').innerText();
            co2Text = co2Text.replaceAll(',', '');
            return parseInt(co2Text);
        }

        const getCurrentHolding = async () => {
            let holdingText = await this.page.locator('#holding').innerText();
            holdingText = holdingText.replaceAll(',', '');
            return parseInt(holdingText);
        }

        const getEmptyCO2 = async () => {
            const emptyText = (await this.page.locator('#remCapacity').innerText()).replaceAll(',', '')
            return parseInt(emptyText);
        }

        const clearInput = async () => {
            await this.moveAndClick(purchaseInput);
            await GeneralUtils.randomSleep(500, 1200);

            await purchaseInput.click();
            await purchaseInput.press('Control+a');
            await purchaseInput.press('Backspace');
            await GeneralUtils.randomSleep(400, 900);
        }

        const readInputAmount = async () => {
            const raw = await purchaseInput.inputValue().catch(() => '');
            const parsed = parseInt(raw.replace(/[^0-9]/g, ''), 10);
            return Number.isNaN(parsed) ? 0 : parsed;
        }

        // Ukur harga satuan asli dengan cara yang sama seperti buyFuel: ketik 1000 dulu,
        // lalu baca total harganya. Angka yang terbaca = harga per 1000 unit,
        // konsisten dengan MAX_CO2_PRICE (sebelumnya bot membaca total harga dari
        // jumlah default di input, yang bukan harga satuan).
        const probeUnitPricePer1000 = async () => {
            await clearInput();
            await purchaseInput.pressSequentially('1000', { delay: Math.floor(Math.random() * 80) + 40 });
            await GeneralUtils.randomSleep(800, 1400);
            return await getTotalPrice();
        }

        // Ketik jumlah target, lalu BACA BALIK isi input. Halaman bisa me-reset isi
        // input di tengah jalan (kejadian nyata: bot hanya terbeli 100 / 1000 unit).
        // Jika tidak cocok, coba sekali lagi dengan fill langsung.
        const setAmountVerified = async (amount: number) => {
            await clearInput();
            await purchaseInput.pressSequentially(amount.toString(), { delay: Math.floor(Math.random() * 80) + 40 });
            await GeneralUtils.randomSleep(1000, 2000);

            let readBack = await readInputAmount();
            if (readBack !== amount) {
                console.log(`CO2 amount read-back mismatch after typing: intended ${amount}, field shows ${readBack}. Retrying with direct fill...`);
                await purchaseInput.fill(amount.toString());
                await GeneralUtils.randomSleep(800, 1400);
                readBack = await readInputAmount();
            }
            return readBack;
        }

        const emptyCo2 = await getEmptyCO2();
        if(emptyCo2 === 0) {
            console.log('CO2 tank is already full.');
            return;
        }

        const curHolding = await getCurrentHolding();

        const buyAmount = async (amount: number, label: string) => {
            // Jangan pernah klik Purchase jika jumlah di input tidak terverifikasi:
            // lebih baik tidak membeli sama sekali daripada membeli 100 unit lalu lapor sukses.
            const verifiedAmount = await setAmountVerified(amount);
            if (verifiedAmount !== amount) {
                console.log(`WARNING: CO2 purchase aborted - could not set amount reliably (intended ${amount}, field shows ${verifiedAmount}). Not clicking Purchase.`);
                return;
            }

            const purchaseButton = this.page.getByRole('button', { name: ' Purchase' });
            await this.moveAndClick(purchaseButton);

            await GeneralUtils.randomSleep(5000, 6000);
            const holdingAfter = await getCurrentHolding();
            const actualBought = holdingAfter - curHolding;
            console.log('Actual CO2 bought (verified holding delta): ' + actualBought);
            if (actualBought < amount * 0.9) {
                console.log(`WARNING: CO2 purchase underfilled - intended ${amount}, actually bought ${actualBought}. A later run will top up the rest.`);
            } else {
                console.log(`Bought Co2 Successfully! Verified amount bought: ${actualBought}${label}`);
            }
        }

        const unitPricePer1000 = await probeUnitPricePer1000();

        console.log('Current Co2 Price (per 1000): ' + unitPricePer1000);
        console.log('Current CO2 holding: ' + curHolding + ', remaining capacity: ' + emptyCo2);

        // GARIS PENYELAMAT (keputusan user 2026-10-07): stok di bawah 300rb berarti
        // beli penuh tanpa peduli harga. Mencegah stok habis total yang memaksa
        // pembelian manual di harga puncak.
        if(curHolding < 300000) {
            console.log('CO2 SURVIVAL BUY: holding ' + curHolding + ' is below 300000 - buying full remaining capacity regardless of price (current: ' + unitPricePer1000 + ' per 1000).');
            await buyAmount(emptyCo2, ' (Survival Buy)');
        }
        // Beli CO2 jika harga satuan di bawah target maksimum
        else if(unitPricePer1000 > 0 && unitPricePer1000 < this.maxCo2Price) {
            await buyAmount(emptyCo2, '');
        }
        // Kondisi darurat jika stok kritis dan harga masih di bawah plafon darurat
        else if(curHolding < 1000000 && unitPricePer1000 > 0 && unitPricePer1000 < 180) {
            await buyAmount(Math.min(1000000, emptyCo2), ' (Emergency Buy)');
        }
        else {
            console.log('CO2 purchase skipped: unit price per 1000 is ' + unitPricePer1000 + ' (max ' + this.maxCo2Price + '), holding ' + curHolding + '.');
        }
    }
}
