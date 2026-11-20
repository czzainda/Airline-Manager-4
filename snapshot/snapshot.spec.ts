// Fleet snapshot collector (2026-11-18; capture layer rewritten the
// same evening on the Fleet Recon v1-v4 map; pagination + drift fixes
// added after the first live run, 44453619523). READ-ONLY in game: it
// logs in with the bot's own login, opens the ROUTES panel, reads the
// Routes / Pending / Fleet / Parked sub-tabs, validates the parse with
// the built-in self-check (utils/snapshot.utils.ts) and only then
// updates snapshots/latest.json. It never clicks Depart / Buy / Sell /
// Repair / Check / Deliver; the only clicks are the panel tile, the
// panel's own view tabs and the Routes list's own pagination links.
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
//   - The Routes list PAGINATES at 20 rows/page via links whose
//     onclick is Ajax('routes.php?start=N', ...). Page >= 2 also
//     carries a start=0 link back to page 1, so "the first start=
//     link" bounces 1 <-> 2 forever (first live run did exactly that
//     for 40 pages). Pagination must follow the smallest start
//     GREATER than the current page's start.
//
// Drift discipline (first live run, second lesson): aircraft finish
// maintenance and move between tabs while a capture runs, so each
// tab's header count is re-read immediately before that tab is
// captured, the fast tabs go first, and the slow Routes capture goes
// last. A page is only accepted once its "#CL-" row count is stable
// across 3 consecutive polls (length alone plateaus mid-render).
//
// Self-healing (added 2026-11-18 20:05 at the user's direction -
// "recognise the problem during collection and fix it on the spot"):
// every tab is verified the moment it is captured (parsed count vs
// its own fresh header, unparsed blocks == 0); a mismatch re-captures
// THAT tab on the spot, max 3 attempts. Pagination that revisits an
// already-seen page signature is treated as a loop and stops at
// once. After all four tabs, the header is read once more and any
// tab whose count moved during the run is re-captured (drift sweep,
// max 2 attempts). Counts can sit still while an aircraft crosses
// tabs mid-run, so an identity sweep follows: a registration found
// in two tabs at once re-captures the earlier-captured tab (max 2
// sweeps; added 2026-11-20, run 44794576556). Every correction is
// recorded in a healing log
// that ships with the snapshot (or the invalid record). Healing may
// ONLY re-collect data: it never edits a number and never relaxes
// the final self-check - a tab that will not heal fails the run
// exactly as before.
//
// ROOT CAUSE of the 2026-11-18 collector failures (found that
// night from run 44461007086's committed raw text, confirmed on
// the next run's): the captures were COMPLETE all along - 217
// rows against a header of 217, five full passes of 213 against
// 213. What discarded ~30 routes per run was the PARSER: it
// deduped by the #CL- route number, but that number is not
// unique - #CL-0076 alone labels ten different routes.
// Registrations are the unique key (217 rows = 217 distinct
// regs). parseRoutes now dedupes by reg (see snapshot.utils.ts),
// and the pagination stop condition below counts distinct regs.
// An earlier "the list moves while paging" theory - and the
// batch-fetch / union machinery briefly built on it - was wrong
// and has been removed; the identical shortfall on every
// re-capture was the dedupe eating the same rows, not drift.
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
    parseParked,
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
    test.setTimeout(780000);

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

    // In-run correction log; shipped with the snapshot / invalid
    // record so every act of self-healing leaves evidence.
    const heal: Record<string, unknown>[] = [];

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
    const readHeader = async (): Promise<HeaderCounts | null> => {
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
        return parseHeaderCounts(headerText);
    };

    const firstHeader = await readHeader();
    if (!firstHeader) {
        failInvalid(['header: counts not readable from tab buttons']);
    }
    log(`Header at open: routes=${firstHeader!.routes} fleet=${firstHeader!.fleet} parked=${firstHeader!.parked} pending=${firstHeader!.pending}`);

    // --- Per-tab capture of #routesContainer, following pagination. --
    const containerText = async (): Promise<string> =>
        await page
            .evaluate(() => {
                const el = document.querySelector('#routesContainer');
                return el ? (el as HTMLElement).innerText : '';
            })
            .catch(() => '');

    const rowShape = (text: string): string => {
        // Change/settle signature that ignores ticking countdowns:
        // first route number + number of route blocks on the page.
        const first = /#(CL-\S+)/.exec(text);
        const count = (text.match(/#CL-/g) || []).length;
        return (first ? first[1] : '') + '|' + count;
    };

    const waitSettled = async (): Promise<string> => {
        // Accept the page only once its row shape is stable across 3
        // consecutive polls (text length plateaus mid-render). Polls
        // are 300ms: at 1s polls a full Routes pass took minutes and
        // the list moved underneath it (run 44461007086).
        let lastShape = '';
        let stable = 0;
        let text = '';
        for (let s = 0; s < 40 && stable < 3; s++) {
            await page.waitForTimeout(300);
            text = await containerText();
            const shape = rowShape(text);
            if (shape === lastShape)
                stable++;
            else
                stable = 0;
            lastShape = shape;
        }
        return text;
    };

    const collectTab = async (tab: string, expected: number): Promise<string[]> => {
        const shapeBefore = rowShape(await containerText());
        const btn = page.locator('.listBtns', { hasText: tab }).first();
        await btn.click({ timeout: 10000 }).catch((e) =>
            log(`Tab ${tab} button click failed: ${String(e).slice(0, 120)}`)
        );
        // Wait for the Ajax swap to show a different row shape.
        for (let s = 0; s < 30; s++) {
            await page.waitForTimeout(300);
            if (rowShape(await containerText()) !== shapeBefore)
                break;
        }
        const pages: string[] = [];
        // Progress is counted in distinct REGISTRATIONS: the #CL-
        // route number repeats across routes and undercounts (see
        // the root-cause note at the top of this file).
        const seenRegs = new Set<string>();
        const visitedSigs = new Set<string>();
        let currentStart = 0;
        for (let p = 0; p < 30; p++) {
            const text = await waitSettled();
            const sig = rowShape(text);
            if (pages.length > 0 && visitedSigs.has(sig)) {
                // A page signature we already collected: pagination
                // is looping. Stop at once and let the caller's
                // verify-and-recapture layer deal with it.
                log(`Tab ${tab}: pagination loop detected (page signature ${sig} seen again); stopping.`);
                heal.push({ tab, kind: 'pagination-loop', signature: sig, atPage: p + 1 });
                break;
            }
            visitedSigs.add(sig);
            pages.push(text);
            for (const m of text.match(/^B-[0-9][0-9A-Za-z-]* - /gm) || [])
                seenRegs.add(m.replace(/ - $/, ''));
            if (expected > 0 && seenRegs.size >= expected)
                break;
            // Follow the smallest start GREATER than the current
            // page's start; page >= 2 also links back to start=0,
            // which is what trapped the first live run in a 1<->2 loop.
            const nextStart = await page.evaluate((cur: number) => {
                const root = document.querySelector('#routesContainer');
                if (!root)
                    return -1;
                const starts: number[] = [];
                for (const e of Array.from(root.querySelectorAll('[onclick]'))) {
                    const m = /routes\.php\?start=(\d+)/.exec(e.getAttribute('onclick') || '');
                    if (m)
                        starts.push(parseInt(m[1], 10));
                }
                const next = starts.filter((s) => s > cur).sort((a, b) => a - b)[0];
                if (next === undefined)
                    return -1;
                const el = Array.from(root.querySelectorAll('[onclick]')).find((e) =>
                    (e.getAttribute('onclick') || '').includes('routes.php?start=' + next)
                );
                if (!el)
                    return -1;
                (el as HTMLElement).click();
                return next;
            }, currentStart);
            if (nextStart < 0)
                break;
            const prevShape = rowShape(text);
            let changed = false;
            for (let s = 0; s < 30; s++) {
                await page.waitForTimeout(300);
                if (rowShape(await containerText()) !== prevShape) {
                    changed = true;
                    break;
                }
            }
            if (!changed) {
                log(`Tab ${tab}: pagination to start=${nextStart} did not change the page; stopping.`);
                break;
            }
            currentStart = nextStart;
        }
        log(`Tab ${tab}: ${pages.length} page(s) collected, ${seenRegs.size} unique aircraft seen.`);
        return pages;
    };

    // --- Self-healing capture: verify each tab the moment it is
    // captured; re-capture on the spot when its parsed count disagrees
    // with its own fresh header or a block fails to parse. ----------
    const tabCount = (tab: string, text: string): { count: number; unparsed: number } => {
        if (tab === 'Routes')
            return { count: parseRoutes(text).length, unparsed: countUnparsedRouteLines(text) };
        if (tab === 'Pending')
            return { count: parsePending(text).length, unparsed: countUnparsedPendingLines(text) };
        if (tab === 'Fleet')
            return {
                count: Object.values(parseFleetByType(text)).reduce((a, b) => a + b, 0),
                unparsed: 0,
            };
        return { count: parseParked(text).length, unparsed: 0 };
    };

    const tabExpected = (tab: string, h: HeaderCounts): number =>
        tab === 'Routes' ? h.routes : tab === 'Pending' ? h.pending : tab === 'Parked' ? h.parked : h.fleet;

    interface TabResult {
        pages: string[];
        text: string;
        header: HeaderCounts;
        count: number;
        unparsed: number;
        ok: boolean;
    }

    const captureVerified = async (tab: string, maxAttempts: number): Promise<TabResult> => {
        let result: TabResult | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const hdr = (await readHeader()) ?? firstHeader!;
            const expected = tabExpected(tab, hdr);
            const pages = await collectTab(tab, expected);
            const text = pages.join('\n=== PAGE BREAK ===\n');
            const { count, unparsed } = tabCount(tab, text);
            const ok = count === expected && unparsed === 0;
            result = { pages, text, header: hdr, count, unparsed, ok };
            log(`Tab ${tab} attempt ${attempt}: parsed ${count}/${expected}, unparsed ${unparsed} -> ${ok ? 'OK' : 'MISMATCH, re-capturing'}`);
            if (ok)
                return result;
            heal.push({ tab, kind: 'recapture', attempt, expected, count, unparsed });
        }
        return result!;
    };

    // Fast, drift-prone tabs first; the Routes capture last. Every
    // tab goes through the same verify-and-recapture path; with the
    // parser keyed by registration, a single complete pass closes.
    const results: Record<string, TabResult> = {};
    for (const tab of ['Pending', 'Parked', 'Fleet', 'Routes'])
        results[tab] = await captureVerified(tab, 3);

    // Drift sweep: one more header read; any tab whose count moved
    // since its verified capture is re-captured once more.
    const sweepHeader = await readHeader();
    if (sweepHeader) {
        for (const tab of ['Pending', 'Parked', 'Fleet', 'Routes']) {
            const now = tabExpected(tab, sweepHeader);
            const was = tabExpected(tab, results[tab].header);
            if (now !== was) {
                log(`Drift sweep: ${tab} header moved ${was} -> ${now} during the run; re-capturing.`);
                heal.push({ tab, kind: 'drift-sweep', was, now });
                results[tab] = await captureVerified(tab, 2);
            }
        }
    }

    // Identity sweep: counts can sit still while an aircraft crosses
    // tabs mid-run. Run 44794576556 (2026-11-20) captured B-020 in
    // Pending with 37 seconds of maintenance left, then in Routes
    // already departed - both captures true, the stitched snapshot
    // impossible, and the uniqueness check rightly rejected it. The
    // count-based drift sweep above cannot see identity moving under
    // stable counts. So: a registration found in two tabs at once
    // re-captures the earlier-captured tab (the later capture holds
    // the fresher truth), then the overlap is checked again. Two
    // sweeps at most; a still-overlapping snapshot falls through to
    // the self-check and is rejected - the sweep re-reads the game,
    // it never edits a row.
    const tabRegs = (tab: string): Set<string> => {
        const text = results[tab].text;
        const rows =
            tab === 'Routes'
                ? parseRoutes(text)
                : tab === 'Pending'
                  ? parsePending(text)
                  : parseParked(text);
        return new Set(rows.map((r) => r.reg));
    };
    for (let sweep = 1; sweep <= 2; sweep++) {
        const byTab: Record<string, Set<string>> = {
            Pending: tabRegs('Pending'),
            Parked: tabRegs('Parked'),
            Routes: tabRegs('Routes'),
        };
        const stale = new Set<string>();
        const pairs: [string, string][] = [
            ['Pending', 'Routes'],
            ['Parked', 'Routes'],
            ['Pending', 'Parked'],
        ];
        for (const [earlier, later] of pairs)
            for (const reg of byTab[earlier])
                if (byTab[later].has(reg)) stale.add(earlier);
        if (stale.size === 0) break;
        for (const tab of stale) {
            log(`Identity sweep ${sweep}: a registration appears in ${tab} and in a later tab; re-capturing ${tab}.`);
            heal.push({ tab, kind: 'identity-sweep', sweep });
            results[tab] = await captureVerified(tab, 2);
        }
    }

    // The self-check header assembles each tab's own verified count;
    // the fleet total comes from the last (Routes-time) header.
    const header: HeaderCounts = {
        routes: results['Routes'].header.routes,
        pending: results['Pending'].header.pending,
        parked: results['Parked'].header.parked,
        fleet: results['Routes'].header.fleet,
    };
    log(`Header for check: routes=${header.routes} fleet=${header.fleet} parked=${header.parked} pending=${header.pending}; healing events: ${heal.length}`);

    const routesText = results['Routes'].text;
    const pendingText = results['Pending'].text;
    const fleetText = results['Fleet'].text;
    const parkedText = results['Parked'].text;

    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'routes.txt'), routesText);
    fs.writeFileSync(path.join(rawDir, 'pending.txt'), pendingText);
    fs.writeFileSync(path.join(rawDir, 'fleet.txt'), fleetText);
    fs.writeFileSync(path.join(rawDir, 'parked.txt'), parkedText);

    // Parked rows: real format verified 2026-11-19 from run
    // 44656179369's committed raw text (first capture with a parked
    // aircraft). parseParked in utils handles it; the provisional
    // pending-style regex that stood here before parsed 0 of 1 and
    // the closure check rejected that run - the net working as
    // designed, and the raw text it committed taught the format.
    const parked = parseParked(parkedText);

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

    if (!check.valid) {
        failInvalid(check.reasons, {
            header,
            healing: heal,
            parsedCounts: {
                routes: snap.routes.length,
                pending: snap.pending.length,
                parked: snap.parked.length,
            },
        });
    }

    writeJson(path.join(SNAP_DIR, 'history', stamp + '.json'), { ...snap, healing: heal });
    writeJson(path.join(SNAP_DIR, 'latest.json'), { ...snap, healing: heal });
    state.consecutiveInvalid = 0;
    state.lastValidAt = takenAt;
    writeJson(path.join(SNAP_DIR, 'state.json'), state);
    log(
        `VALID: fleet ${header.fleet} = routes ${snap.routes.length} + pending ${snap.pending.length} + parked ${snap.parked.length}; self-check passed.`
    );
});
