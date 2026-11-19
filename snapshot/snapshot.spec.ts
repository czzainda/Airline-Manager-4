// Fleet snapshot collector (2026-11-18). READ-ONLY in game: it logs in
// with the bot's own login, opens the ROUTES panel, reads the Routes /
// Pending / Fleet / Parked sub-tabs, validates the parse with the
// built-in self-check (utils/snapshot.utils.ts) and only then updates
// snapshots/latest.json. It never clicks Depart / Buy / Sell / Repair /
// Check / Deliver or any other state-changing control; the only clicks
// are the panel tile and the panel's own view tabs.
//
// Outputs (committed back by the workflow):
//   snapshots/latest.json          last VALID snapshot
//   snapshots/history/<ts>.json    every valid snapshot
//   snapshots/invalid/<ts>.json    rejected snapshots + reasons
//   snapshots/state.json           consecutiveInvalid counter / halt flag
// Raw panel text goes to snapshot-raw/ (workflow artifact, not committed).
//
// Halt rule: 2 consecutive invalid snapshots set state.halted; later
// runs then no-op until a human clears the flag.

import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { GeneralUtils } from '../utils/general.utils';
import {
    parseHeaderCounts,
    parseRoutes,
    parsePending,
    parseFleetByType,
    countUnparsedRouteLines,
    countUnparsedPendingLines,
    selfCheck,
    SnapshotData,
} from '../utils/snapshot.utils';

const SNAP_DIR = path.join(process.cwd(), 'snapshots');
const RAW_DIR = path.join(process.cwd(), 'snapshot-raw');

interface SnapState {
    consecutiveInvalid: number;
    halted: boolean;
    lastValidAt: string | null;
    lastInvalidAt: string | null;
}

function readJson<T>(file: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

function writeJson(file: string, data: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

test('Fleet snapshot (read-only)', async ({ page }) => {
    test.setTimeout(420000);

    const state: SnapState =
        readJson<SnapState>(path.join(SNAP_DIR, 'state.json')) ?? {
            consecutiveInvalid: 0,
            halted: false,
            lastValidAt: null,
            lastInvalidAt: null,
        };

    if (state.halted) {
        console.log('[Snapshot] HALTED after consecutive invalid snapshots; skipping collection until the flag is cleared by a human.');
        return;
    }

    const generalUtils = new GeneralUtils(page);
    await generalUtils.login(page);
    console.log('[Snapshot] Logged in; opening ROUTES panel...');

    // Open the panel the way the main bot's depart module does (proven
    // daily): blank-space click on the top strip, click the routes tile,
    // 4-6s stabilisation, then the panel's own #departAll button as the
    // "panel is open" signal. The first version instead waited for a
    // "Routes (222)" header text whose exact format was assumed from the
    // probe notes and never verified; run 44423513135 logged in fine and
    // then died on that wait (TimeoutError at the old line 85).
    await page.mouse.click(400, 20).catch(() => {});
    const routesTile = page.locator('#mapRoutes').getByRole('img');
    await GeneralUtils.moveAndClick(page, routesTile, 30000).catch(async () => {
        await GeneralUtils.moveAndClick(page, page.getByText('FLEET').first(), 15000);
    });
    await page.waitForTimeout(5000);

    const panelOpen = await page
        .locator('#departAll')
        .waitFor({ state: 'visible', timeout: 30000 })
        .then(() => true)
        .catch(() => false);
    if (!panelOpen) {
        const seen = await page
            .evaluate(() => (document.body.innerText || '').slice(0, 800))
            .catch(() => '');
        console.log(
            '[Snapshot] Panel did not open; page text head: ' +
                seen.replace(/\s+/g, ' ')
        );
        throw new Error(
            '[Snapshot] ROUTES panel did not open (#departAll never visible)'
        );
    }
    await page.waitForTimeout(2000);

    // Smallest container that holds both Routes (...) and Pending (...).
    const panelText = async (): Promise<string> => {
        return await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('div'));
            const cand = els.filter((e) => {
                const t = e.textContent || '';
                return t.includes('Routes') && t.includes('Pending');
            });
            cand.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
            const el: any = cand.length ? cand[0] : document.body;
            return (el.innerText || el.textContent || '') as string;
        });
    };

    // Tab labels carry a count whose exact rendering is unverified
    // ("Routes (222)" vs "Routes 222" vs a badge), so match the tab leaf
    // element with an anchored pattern that tolerates the count, and fall
    // back to the bare name.
    const clickTab = async (name: string) => {
        const anchored = new RegExp('^\\s*' + name + '(\\s*\\(\\d+\\))?\\s*$');
        await GeneralUtils.moveAndClick(page, page.getByText(anchored).first(), 15000).catch(
            async () => {
                await GeneralUtils.moveAndClick(
                    page,
                    page.getByText(new RegExp(name)).first(),
                    15000
                );
            }
        );
        await page.waitForTimeout(1500);
    };

    // Scroll-collect: the routes list may render inside a scrollable box,
    // so sweep it and union the parsed rows until the count is stable.
    const collectTabText = async (tabName: string): Promise<string> => {
        await clickTab(tabName);
        let combined = '';
        let lastLen = -1;
        let stableRounds = 0;
        for (let i = 0; i < 30 && stableRounds < 2; i++) {
            const t = await panelText();
            combined += '\n' + t;
            const box = await page.locator('#departAll').boundingBox().catch(() => null);
            if (box) {
                await page.mouse.move(box.x + box.width / 2, box.y + 300);
                await page.mouse.wheel(0, 900);
            }
            await page.waitForTimeout(450);
            if (combined.length === lastLen)
                stableRounds++;
            else
                stableRounds = 0;
            lastLen = combined.length;
        }
        return combined;
    };

    const routesText = await collectTabText('Routes');
    const pendingText = await collectTabText('Pending');
    const fleetText = await collectTabText('Fleet');
    let parkedText = '';
    const header = parseHeaderCounts(routesText) ?? parseHeaderCounts(await panelText());
    if (header && header.parked > 0) {
        parkedText = await collectTabText('Parked');
    }

    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(path.join(RAW_DIR, 'routes.txt'), routesText);
    fs.writeFileSync(path.join(RAW_DIR, 'pending.txt'), pendingText);
    fs.writeFileSync(path.join(RAW_DIR, 'fleet.txt'), fleetText);
    if (parkedText)
        fs.writeFileSync(path.join(RAW_DIR, 'parked.txt'), parkedText);

    const takenAt = new Date().toISOString();

    if (!header) {
        const reasons = ['header counts (Routes/Fleet/Parked/Pending) not found in panel text'];
        writeJson(path.join(SNAP_DIR, 'invalid', takenAt.replace(/[:.]/g, '-') + '.json'), { takenAt, reasons });
        state.consecutiveInvalid += 1;
        state.lastInvalidAt = takenAt;
        if (state.consecutiveInvalid >= 2)
            state.halted = true;
        writeJson(path.join(SNAP_DIR, 'state.json'), state);
        throw new Error('[Snapshot] INVALID: ' + reasons.join('; '));
    }

    // Parked rows: no verified text format yet (count was 0 at probe
    // time). Try the pending-style "Type, REG" shape; if the count does
    // not close, the self-check rejects the snapshot and we learn the
    // real format from the raw artifact instead of guessing silently.
    const parked: { reg: string; type: string }[] = [];
    if (header.parked > 0) {
        const re = /([A-Za-z0-9][A-Za-z0-9\-]*)\s*,\s*([A-Z]-[0-9][0-9A-Za-z-]*)/g;
        const t = parkedText.replace(/\s+/g, ' ');
        let m: RegExpExecArray | null;
        while ((m = re.exec(t)) !== null)
            parked.push({ type: m[1], reg: m[2] });
    }

    const snap: SnapshotData = {
        takenAt,
        header,
        routes: parseRoutes(routesText),
        pending: parsePending(pendingText),
        parked,
        fleetByType: parseFleetByType(fleetText),
    };

    const previous = readJson<SnapshotData>(path.join(SNAP_DIR, 'latest.json'));
    const check = selfCheck(
        snap,
        countUnparsedRouteLines(routesText),
        countUnparsedPendingLines(pendingText),
        previous ? previous.header.fleet : null
    );

    const stamp = takenAt.replace(/[:.]/g, '-');
    if (!check.valid) {
        writeJson(path.join(SNAP_DIR, 'invalid', stamp + '.json'), {
            takenAt,
            reasons: check.reasons,
            header,
            parsedCounts: {
                routes: snap.routes.length,
                pending: snap.pending.length,
                parked: snap.parked.length,
            },
        });
        state.consecutiveInvalid += 1;
        state.lastInvalidAt = takenAt;
        if (state.consecutiveInvalid >= 2)
            state.halted = true;
        writeJson(path.join(SNAP_DIR, 'state.json'), state);
        console.log('[Snapshot] INVALID: ' + check.reasons.join('; '));
        throw new Error('[Snapshot] INVALID: ' + check.reasons.join('; '));
    }

    writeJson(path.join(SNAP_DIR, 'history', stamp + '.json'), snap);
    writeJson(path.join(SNAP_DIR, 'latest.json'), snap);
    state.consecutiveInvalid = 0;
    state.lastValidAt = takenAt;
    writeJson(path.join(SNAP_DIR, 'state.json'), state);
    console.log(
        `[Snapshot] VALID: fleet ${header.fleet} = routes ${snap.routes.length} + pending ${snap.pending.length} + parked ${snap.parked.length}; self-check passed.`
    );
});
