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
// max 2 attempts). Every correction is recorded in a healing log
// that ships with the snapshot (or the invalid record). Healing may
// ONLY re-collect data: it never edits a number and never relaxes
// the final self-check - a tab that will not heal fails the run
// exactly as before.
//
// Batch fetch + union (added 2026-11-18 night, after live run
// 44461007086 - the self-healing run - failed closure at 187/217):
// that run's committed raw text held 217 route-row instances but
// only 187 distinct route numbers: 30 rows were captured twice and
// 30 routes were never on any captured page. The list moves while
// it is being paged (rows re-sort / change state between page
// reads), so a minutes-long click-through can never be coherent,
// and re-capturing the same slow way reproduced the same hole
// three times in a row (186, 186, 186). The parser was innocent
// throughout (unparsed == 0; local replay of the raw text parses
// perfectly). Consequences, both implemented below:
//   - Routes is captured FIRST-HAND inside the page: one evaluate
//     fetches every routes.php?start=N page concurrently (the whole
//     list in ~seconds, before it can move), each response is
//     rendered in a hidden element and read as innerText, exactly
//     like the live container. A sample of the raw response ships
//     with the run's raw dump, so a format surprise is diagnosable
//     from that same run.
//   - If the batch does not close against the header, the fallback
//     is the UI click-through, but UNIONED across passes: passes
//     are fast now (300ms polls), each pass slides differently, and
//     parseRoutes dedupes by routeNo, so the union of passes
//     converges on the full list. The closure self-check remains
//     the only judge - it is not relaxed by any of this.
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
        const seenRoutes = new Set<string>();
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
            for (const m of text.match(/#(CL-\S+)/g) || [])
                seenRoutes.add(m);
            if (expected > 0 && seenRoutes.size >= expected)
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
        log(`Tab ${tab}: ${pages.length} page(s) collected, ${seenRoutes.size} unique route(s) seen.`);
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
        const m = text
            .replace(/\s+/g, ' ')
            .match(/([A-Za-z0-9][A-Za-z0-9\-]*)\s*,\s*([A-Z]-[0-9][0-9A-Za-z-]*)/g);
        return { count: m ? m.length : 0, unparsed: 0 };
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

    // --- Routes batch fetch (primary path). One evaluate pulls
    // every routes.php page concurrently (the same URL the list's
    // own pagination links call); each response is rendered in a
    // hidden element and read back as innerText - the same text the
    // live container would give, but the whole list lands within
    // seconds, before it can move. A sample of the raw response is
    // kept for the raw dump so a format surprise is diagnosable
    // from this same run.
    let fetchSample = '';
    let fetchText: string | null = null;
    const fetchRoutesBatch = async (expected: number): Promise<string | null> => {
        const starts: number[] = [];
        for (let s = 0; s < expected; s += 20)
            starts.push(s);
        try {
            const out = await page.evaluate(async (startsArg: number[]) => {
                const holder = document.createElement('div');
                holder.style.cssText =
                    'position:absolute;left:-99999px;top:0;visibility:hidden;';
                document.body.appendChild(holder);
                const htmls = await Promise.all(
                    startsArg.map(async (st) => {
                        const r = await fetch('routes.php?start=' + st + '&sort=', {
                            credentials: 'same-origin',
                            headers: { 'X-Requested-With': 'XMLHttpRequest' },
                        });
                        return await r.text();
                    })
                );
                const texts: string[] = [];
                let sample = '';
                for (const html of htmls) {
                    if (!sample)
                        sample = html.slice(0, 2000);
                    holder.innerHTML = html;
                    texts.push(holder.innerText);
                }
                holder.remove();
                return { texts, sample };
            }, starts);
            fetchSample = out.sample || fetchSample;
            const joined = out.texts.join('\n=== PAGE BREAK ===\n');
            log(`Routes batch fetch: ${out.texts.length} page(s), ${joined.length} chars of text.`);
            return joined;
        } catch (e) {
            log(`Routes batch fetch failed: ${String(e).slice(0, 160)}`);
            return null;
        }
    };

    const captureRoutesVerified = async (maxUiPasses: number): Promise<TabResult> => {
        const hdr = (await readHeader()) ?? firstHeader!;
        const expected = hdr.routes;
        // Primary: batch fetch.
        const fetched = await fetchRoutesBatch(expected);
        let unionText = '';
        if (fetched !== null) {
            fetchText = fetched;
            const { count, unparsed } = tabCount('Routes', fetched);
            const ok = count === expected && unparsed === 0;
            log(`Routes batch: parsed ${count}/${expected}, unparsed ${unparsed} -> ${ok ? 'OK' : 'MISMATCH, falling back to UI passes'}`);
            heal.push({ tab: 'Routes', kind: 'batch-fetch', expected, count, unparsed, ok });
            if (ok)
                return { pages: [fetched], text: fetched, header: hdr, count, unparsed, ok };
            // A clean-parsing but short batch still seeds the union;
            // a batch with unparsed lines is discarded for union
            // purposes (it is still dumped raw for diagnosis).
            if (unparsed === 0)
                unionText = fetched;
        }
        // Fallback: fast UI passes, unioned. parseRoutes dedupes by
        // routeNo, so counting the concatenated text counts the
        // union; each pass slides differently over the moving list.
        // Local simulation (300 trials, each pass missing a random
        // 30 of 217 like run 44461007086): 3 passes complete the
        // union in only ~54% of trials, 5 passes in ~99% - hence 5.
        let last: TabResult | null = null;
        for (let pass = 1; pass <= maxUiPasses; pass++) {
            const pages = await collectTab('Routes', expected);
            const passText = pages.join('\n=== PAGE BREAK ===\n');
            unionText = unionText
                ? unionText + '\n=== PAGE BREAK ===\n' + passText
                : passText;
            const { count, unparsed } = tabCount('Routes', unionText);
            const ok = count === expected && unparsed === 0;
            last = { pages: [unionText], text: unionText, header: hdr, count, unparsed, ok };
            log(`Routes UI union pass ${pass}: union parsed ${count}/${expected}, unparsed ${unparsed} -> ${ok ? 'OK' : 'INCOMPLETE'}`);
            heal.push({ tab: 'Routes', kind: 'union-pass', attempt: pass, expected, count, unparsed });
            if (ok)
                return last;
        }
        return last!;
    };

    // Fast, drift-prone tabs first; Routes last (batch fetch, with
    // unioned UI passes as fallback).
    const results: Record<string, TabResult> = {};
    for (const tab of ['Pending', 'Parked', 'Fleet'])
        results[tab] = await captureVerified(tab, 3);
    results['Routes'] = await captureRoutesVerified(5);

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
                results[tab] =
                    tab === 'Routes'
                        ? await captureRoutesVerified(2)
                        : await captureVerified(tab, 2);
            }
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
    if (fetchText !== null)
        fs.writeFileSync(path.join(rawDir, 'routes-fetch.txt'), fetchText);
    if (fetchSample)
        fs.writeFileSync(path.join(rawDir, 'routes-fetch-sample.txt'), fetchSample);

    // Parked rows: no verified text format yet (count was 0 in every
    // capture so far). Try the pending-style "Type, REG" shape; if the
    // count does not close, the self-check rejects the snapshot and we
    // learn the real format from the committed raw text.
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
