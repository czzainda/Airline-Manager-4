// Fleet snapshot collector (2026-11-18; capture layer rewritten the
// same evening on the Fleet Recon v1-v4 map). READ-ONLY in game: it
// logs in with the bot's own login, opens the ROUTES panel, reads the
// Routes / Pending / Fleet / Parked sub-tabs, validates the parse with
// the built-in self-check (utils/snapshot.utils.ts) and only then
// updates snapshots/latest.json. It never clicks Depart / Buy / Sell /
// Repair / Check / Deliver; the only clicks are the panel tile, the
// panel's own view tabs and the Routes list's own Next pagination.
//
// What the recon map established (all effect-verified live):
//   - login() prints "Logged in successfully!" unconditionally, so
//     arrival at the game map is verified separately: poll for
//     #mapRoutes (recon arrived in 10s; 180s budget here).
//   - The panel opens with ONE moveAndClick on the #mapRoutes tile's
//     img once the page has settled; "open" is proven by #departAll
//     existing and visible inside the popup, never by the click.
//   - Header counts live on the .listBtns tab buttons themselves
//     ("Routes(217)" etc.) plus #hPending / #hParked spans.
//   - Every tab's list is Ajax-loaded into #routesContainer; the old
//     "smallest container holding Routes+Pending" was the header bar
//     and never contained a single row.
//   - The Routes list PAGINATES: page 1 held 13 rows while its Next
//     control points at routes.php?start=20. Page size is not assumed;
//     Next is followed until it disappears and the merged, routeNo-
//     deduped row count must equal the header count (self-check).
//
// Outputs (committed back by the workflow):
//   snapshots/latest.json          last VALID snapshot
//   snapshots/history/<ts>.json    every valid snapshot
//   snapshots/invalid/<ts>.json    rejected snapshots + reasons
//   snapshots/raw/<ts>/*.txt       raw list text of every attempt
//   snapshots/state.json           consecutiveInvalid counter / halt flag
//
// Halt rule: 2 consecutive invalid snapshots set state.halted; later
// runs then no-op until a human clears the flag.

import { test, Page } from '@playwright/test';
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
    HeaderCounts,
} from '../utils/snapshot.utils';

const SNAP_DIR = path.join(process.cwd(), 'snapshots');

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

function log(msg: string) {
    console.log('[Snapshot] ' + msg);
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
        log('HALTED after consecutive invalid snapshots; skipping collection until the flag is cleared by a human.');
        return;
    }

    const takenAt = new Date().toISOString();
    const stamp = takenAt.replace(/[:.]/g, '-');
    const rawDir = path.join(SNAP_DIR, 'raw', stamp);

    // Every failure path funnels here: record the invalid attempt,
    // advance the halt counter, and fail the run (red is the signal;
    // latest.json is never touched by an invalid attempt).
    const failInvalid = (reasons: string[], extra?: Record<string, unknown>): never => {
        writeJson(path.join(SNAP_DIR, 'invalid', stamp + '.json'), {
            takenAt,
            reasons,
            ...(extra || {}),
        });
        state.consecutiveInvalid += 1;
        state.lastInvalidAt = takenAt;
        if (state.consecutiveInvalid >= 2)
            state.halted = true;
        writeJson(path.join(SNAP_DIR, 'state.json'), state);
        throw new Error('[Snapshot] INVALID: ' + reasons.join('; '));
    };

    const generalUtils = new GeneralUtils(page);
    await generalUtils.login(page);

    // --- Arrival: verify the game map actually loaded. --------------
    let arrived = false;
    for (let s = 0; s < 180; s += 5) {
        const n = await page.locator('#mapRoutes').count().catch(() => 0);
        if (n > 0) {
            arrived = true;
            log(`Arrived at game map after ~${s}s.`);
            break;
        }
        await page.waitForTimeout(5000);
    }
    if (!arrived) {
        const head = await page
            .evaluate(() => (document.body.innerText || '').slice(0, 500))
            .catch(() => '');
        failInvalid(['arrival: #mapRoutes never appeared after login (login() does not verify success)'], {
            pageHead: head.replace(/\s+/g, ' '),
            finalUrl: page.url(),
        });
    }
    // Let the map finish settling; recon v3/v4 showed the tile click
    // only lands reliably once the page is quiet.
    await page.waitForTimeout(3000);

    // --- Open the ROUTES panel (A method, effect-verified). ----------
    const panelOpen = async (timeoutMs: number): Promise<boolean> =>
        await page
            .locator('#departAll')
            .waitFor({ state: 'visible', timeout: timeoutMs })
            .then(() => true)
            .catch(() => false);

    let open = false;
    for (let attempt = 1; attempt <= 2 && !open; attempt++) {
        await page.mouse.click(400, 20).catch(() => {});
        await GeneralUtils.moveAndClick(
            page,
            page.locator('#mapRoutes').locator('img'),
            30000
        ).catch(() => {});
        open = await panelOpen(15000);
        log(`Open attempt ${attempt}: ${open ? 'panel open (#departAll visible)' : 'not open'}`);
    }
    if (!open) {
        const head = await page
            .evaluate(() => (document.body.innerText || '').slice(0, 500))
            .catch(() => '');
        failInvalid(['open: ROUTES panel did not open after 2 tile clicks'], {
            pageHead: head.replace(/\s+/g, ' '),
        });
    }

    // --- Header counts from the tab buttons themselves. -------------
    const headerText = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.listBtns')).map(
            (e) => (e.textContent || '').replace(/\s+/g, ' ').trim()
        );
        const spans: string[] = [];
        for (const id of ['hPending', 'hParked']) {
            const el = document.getElementById(id);
            if (el)
                spans.push(id.replace('h', '') + ' (' + (el.textContent || '').trim() + ')');
        }
        return btns.join(' ') + ' ' + spans.join(' ');
    });
    const header: HeaderCounts | null = parseHeaderCounts(headerText);
    if (!header) {
        failInvalid(['header: counts not readable from tab buttons', 'headerText: ' + headerText]);
    }
    log(`Header: routes=${header!.routes} fleet=${header!.fleet} parked=${header!.parked} pending=${header!.pending}`);

    // --- Per-tab capture of #routesContainer, following pagination. --
    const containerText = async (): Promise<string> =>
        await page
            .evaluate(() => {
                const el = document.querySelector('#routesContainer');
                return el ? (el as HTMLElement).innerText : '';
            })
            .catch(() => '');

    const firstRouteNo = (text: string): string => {
        const m = /#(CL-\S+)/.exec(text);
        return m ? m[1] : '';
    };

    const collectTab = async (tab: string): Promise<string[]> => {
        const before = await containerText();
        const btn = page.locator('.listBtns', { hasText: tab }).first();
        await btn.click({ timeout: 10000 }).catch((e) =>
            log(`Tab ${tab} button click failed: ${String(e).slice(0, 120)}`)
        );
        // Wait for the Ajax swap: content changes, then length settles.
        for (let s = 0; s < 8; s++) {
            await page.waitForTimeout(1000);
            if ((await containerText()) !== before)
                break;
        }
        const pages: string[] = [];
        for (let p = 0; p < 40; p++) {
            let len = -1;
            let lastLen = -2;
            for (let s = 0; s < 15 && len !== lastLen; s++) {
                lastLen = len;
                await page.waitForTimeout(1000);
                len = (await containerText()).length;
            }
            const text = await containerText();
            pages.push(text);
            const prevFirst = firstRouteNo(text);
            const clickedNext = await page.evaluate(() => {
                const root = document.querySelector('#routesContainer');
                if (!root)
                    return false;
                const els = Array.from(root.querySelectorAll('[onclick]'));
                const el = els.find((e) =>
                    (e.getAttribute('onclick') || '').includes('routes.php?start=')
                );
                if (!el)
                    return false;
                (el as HTMLElement).click();
                return true;
            });
            if (!clickedNext)
                break;
            let changed = false;
            for (let s = 0; s < 10; s++) {
                await page.waitForTimeout(1000);
                if (firstRouteNo(await containerText()) !== prevFirst) {
                    changed = true;
                    break;
                }
            }
            if (!changed) {
                log(`Tab ${tab}: Next clicked but page content did not change; stopping pagination.`);
                break;
            }
        }
        log(`Tab ${tab}: ${pages.length} page(s) collected.`);
        return pages;
    };

    const routesPages = await collectTab('Routes');
    const pendingPages = await collectTab('Pending');
    const fleetPages = await collectTab('Fleet');
    const parkedPages = await collectTab('Parked');

    const routesText = routesPages.join('\n=== PAGE BREAK ===\n');
    const pendingText = pendingPages.join('\n=== PAGE BREAK ===\n');
    const fleetText = fleetPages.join('\n=== PAGE BREAK ===\n');
    const parkedText = parkedPages.join('\n=== PAGE BREAK ===\n');

    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'routes.txt'), routesText);
    fs.writeFileSync(path.join(rawDir, 'pending.txt'), pendingText);
    fs.writeFileSync(path.join(rawDir, 'fleet.txt'), fleetText);
    fs.writeFileSync(path.join(rawDir, 'parked.txt'), parkedText);

    // Parked rows: no verified text format yet (count was 0 in every
    // capture so far). Try the pending-style "Type, REG" shape; if the
    // count does not close, the self-check rejects the snapshot and we
    // learn the real format from the committed raw text.
    const parked: { reg: string; type: string }[] = [];
    if (header!.parked > 0) {
        const re = /([A-Za-z0-9][A-Za-z0-9\-]*)\s*,\s*([A-Z]-[0-9][0-9A-Za-z-]*)/g;
        const t = parkedText.replace(/\s+/g, ' ');
        let m: RegExpExecArray | null;
        while ((m = re.exec(t)) !== null)
            parked.push({ type: m[1], reg: m[2] });
    }

    const snap: SnapshotData = {
        takenAt,
        header: header!,
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

    if (!check.valid) {
        failInvalid(check.reasons, {
            header,
            parsedCounts: {
                routes: snap.routes.length,
                pending: snap.pending.length,
                parked: snap.parked.length,
            },
        });
    }

    writeJson(path.join(SNAP_DIR, 'history', stamp + '.json'), snap);
    writeJson(path.join(SNAP_DIR, 'latest.json'), snap);
    state.consecutiveInvalid = 0;
    state.lastValidAt = takenAt;
    writeJson(path.join(SNAP_DIR, 'state.json'), state);
    log(
        `VALID: fleet ${header!.fleet} = routes ${snap.routes.length} + pending ${snap.pending.length} + parked ${snap.parked.length}; self-check passed.`
    );
});
