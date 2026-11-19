import { test, type Page, type Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { GeneralUtils } from '../utils/general.utils';

// One-shot reconnaissance (2026-11-18). The snapshot collector failed
// three times at "open the ROUTES popup" (runs 44423513135,
// 44427030018, 44428893585) and each failure only revealed the first
// broken step. This spec does NOT try to collect a snapshot. It maps
// the whole surface in a single run: every candidate entrance, what
// each click actually does, the popup's real DOM structure, and the
// full raw text of all four tabs. It never throws on a missing panel;
// every observation is logged with a [Recon] prefix and written to
// recon-out/, which the recon workflow commits back to the repo.

test.setTimeout(900000);

const OUT = 'recon-out';

function log(msg: string) {
    console.log('[Recon] ' + msg);
}

function writeFile(name: string, content: string) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), content, 'utf8');
}

// What the page currently says about the popup: smallest elements
// whose text mentions "Routes (N)" (checked on textContent, so split
// text nodes in child elements still match on their ancestors),
// whether #departAll exists and what it reads, and every element id
// containing "depart".
async function panelState(page: Page): Promise<any> {
    return await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        const hits = all
            .filter((e) => {
                const t = e.textContent || '';
                return /Routes\s*\(\d+\)/.test(t) && t.length < 160;
            })
            .slice(0, 8)
            .map((e) => ({
                tag: e.tagName,
                id: e.id || '',
                cls: String(e.className || '').slice(0, 60),
                text: (e.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 90),
                html: (e.outerHTML || '').slice(0, 320),
            }));
        const dep = document.querySelector('#departAll') as HTMLElement | null;
        const depInfo = dep
            ? {
                  text: (dep.textContent || '').replace(/\s+/g, ' ').trim(),
                  visible: dep.getBoundingClientRect().width > 0,
              }
            : null;
        const idsWithDepart = all
            .filter((e) => e.id && /depart/i.test(e.id))
            .map((e) => e.id)
            .slice(0, 12);
        return { routesHits: hits, departAll: depInfo, idsWithDepart };
    });
}

async function describeLocator(loc: Locator, label: string) {
    const n = await loc.count().catch(() => -1);
    log(`${label}: count=${n}`);
    for (let i = 0; i < Math.min(n, 4); i++) {
        const d = await loc
            .nth(i)
            .evaluate((e) => {
                const r = e.getBoundingClientRect();
                return {
                    tag: e.tagName,
                    id: e.id || '',
                    cls: String(e.className || '').slice(0, 60),
                    text: (e.textContent || '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 60),
                    box: [
                        Math.round(r.x),
                        Math.round(r.y),
                        Math.round(r.width),
                        Math.round(r.height),
                    ],
                    visible: r.width > 0 && r.height > 0,
                };
            })
            .catch(() => null);
        log(`${label}[${i}]: ${JSON.stringify(d)}`);
    }
}

// Find the Ajax list container inside the popup and mark it with
// data-recon-target so the spec can read/scroll it afterwards.
// Recon v3 proved the list is NOT inside the header container: the
// rows are Ajax-loaded into #routesContainer (tab buttons call
// Ajax('routes.php', ...) / Ajax('fleet.php','routesContainer', ...)
// and scripts operate on $('.fleetConcatList')). Fallbacks: smallest
// element whose rendered text contains "Demand:", else the largest
// scrollable element.
async function markListContainer(page: Page): Promise<any> {
    return await page.evaluate(() => {
        document
            .querySelectorAll('[data-recon-target]')
            .forEach((e) => e.removeAttribute('data-recon-target'));
        let target: Element | null = null;
        let how = '';
        const byId = document.querySelector('#routesContainer');
        if (byId && (byId as HTMLElement).innerText.trim().length > 0) {
            target = byId;
            how = '#routesContainer';
        }
        if (!target) {
            const cands = Array.from(document.querySelectorAll('*')).filter(
                (e) => ((e as HTMLElement).innerText || '').includes('Demand:')
            );
            cands.sort(
                (a, b) =>
                    ((a as HTMLElement).innerText || '').length -
                    ((b as HTMLElement).innerText || '').length
            );
            if (cands.length) {
                target = cands[0];
                how = 'smallest Demand: container';
            }
        }
        if (!target) {
            const sc = Array.from(document.querySelectorAll('*')).filter(
                (e) => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 50
            );
            sc.sort(
                (a, b) =>
                    ((b as HTMLElement).innerText || '').length -
                    ((a as HTMLElement).innerText || '').length
            );
            if (sc.length) {
                target = sc[0];
                how = 'largest scrollable';
            }
        }
        if (!target) return null;
        target.setAttribute('data-recon-target', '1');
        const el = target as HTMLElement;
        return {
            how,
            tag: el.tagName,
            id: el.id || '',
            cls: String(el.className || '').slice(0, 80),
            len: el.innerText.length,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        };
    });
}

test('Fleet recon (read-only mapping)', async ({ page }) => {
    const summary: Record<string, unknown> = {};
    try {
        // Clear last run's outputs so stale files can never pose as
        // this run's products (v2's arrival.txt did exactly that).
        fs.rmSync(OUT, { recursive: true, force: true });
        summary.runStartedAt = new Date().toISOString();
        const generalUtils = new GeneralUtils(page);
        await generalUtils.login(page);
        log('Login reported success. Verifying arrival at the game map...');

        // Arrival verification (added after recon #1, run 44431575246:
        // login reported success but the page held no game elements at
        // all - the only "FLEET" text was a hidden marketing paragraph).
        // Poll for up to 180s for a real map signal; log the URL and
        // page head at every poll so a slow load is measured, not
        // guessed. If a PLAY FREE NOW button shows up mid-poll (the
        // known landing-page detour the main bot's login also handles),
        // click it once - that completes login, it is not a game action.
        const arrivedAt = async (): Promise<boolean> => {
            return await page.evaluate(() => {
                if (document.querySelector('#mapRoutes')) return true;
                const ids = Array.from(document.querySelectorAll('[id]')).some(
                    (e) => /map|fleet|route/i.test(e.id)
                );
                if (ids) return true;
                const fleetVisible = Array.from(
                    document.querySelectorAll('*')
                ).some((e) => {
                    const r = e.getBoundingClientRect();
                    return (
                        (e.textContent || '').trim() === 'FLEET' &&
                        r.width > 0 &&
                        r.height > 0
                    );
                });
                return fleetVisible;
            });
        };

        let arrived = false;
        let arrivalSeconds = -1;
        let playClicked = false;
        for (let s = 0; s <= 180; s += 10) {
            if (await arrivedAt()) {
                arrived = true;
                arrivalSeconds = s;
                break;
            }
            const head = await page
                .evaluate(() =>
                    (document.body.innerText || '')
                        .replace(/\s+/g, ' ')
                        .slice(0, 200)
                )
                .catch(() => '');
            log(`Arrival poll t=${s}s url=${page.url()} head: ${head}`);
            if (!playClicked && s >= 60) {
                const play = page.getByText('PLAY FREE NOW').first();
                const vis = await play.isVisible().catch(() => false);
                if (vis) {
                    log('PLAY FREE NOW is visible; clicking it to complete login...');
                    await play.click({ timeout: 10000 }).catch(() => {});
                    playClicked = true;
                }
            }
            if (s < 180) await page.waitForTimeout(10000);
        }
        summary.arrived = arrived;
        summary.arrivalSeconds = arrivalSeconds;
        summary.finalUrl = page.url();
        log(`Arrival: ${arrived} after ${arrivalSeconds}s, url=${page.url()}`);

        if (!arrived) {
            const dump = await page.evaluate(() => {
                const ids = Array.from(document.querySelectorAll('[id]'))
                    .map((e) => e.id)
                    .slice(0, 150);
                return (
                    'URL: ' +
                    location.href +
                    '\n\nIDS: ' +
                    ids.join(', ') +
                    '\n\nTEXT:\n' +
                    (document.body.innerText || '').slice(0, 8000)
                );
            });
            writeFile('arrival.txt', dump);
            await page
                .screenshot({ path: path.join(OUT, 'arrival.png'), fullPage: true })
                .catch(() => {});
            log('Never arrived at the map; arrival.txt/png written. Ending recon.');
            writeFile('summary.json', JSON.stringify(summary, null, 2));
            return;
        }

        // 1) Candidate inventory.
        await describeLocator(page.locator('#mapRoutes'), '#mapRoutes');
        await describeLocator(page.locator('#mapRoutes img'), '#mapRoutes img');
        await describeLocator(page.getByText('FLEET'), "getByText('FLEET')");
        await describeLocator(
            page.getByText('FLEET', { exact: true }),
            "getByText('FLEET', exact)"
        );
        await describeLocator(
            page.getByText('Fleet & routes'),
            "getByText('Fleet & routes')"
        );
        const idScan = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[id]'))
                .filter((e) => /map|fleet|route|menu/i.test(e.id))
                .slice(0, 40)
                .map((e) => {
                    const r = e.getBoundingClientRect();
                    return {
                        id: e.id,
                        tag: e.tagName,
                        visible: r.width > 0,
                        box: [
                            Math.round(r.x),
                            Math.round(r.y),
                            Math.round(r.width),
                            Math.round(r.height),
                        ],
                    };
                });
        });
        log('id scan (map|fleet|route|menu): ' + JSON.stringify(idScan));
        summary.idScan = idScan;

        log('State before any click: ' + JSON.stringify(await panelState(page)));

        // 2) Click attempts, checking the state after each one.
        const attempts: Array<{ name: string; run: () => Promise<void> }> = [
            {
                name: 'A: moveAndClick #mapRoutes img',
                run: async () => {
                    await GeneralUtils.moveAndClick(
                        page,
                        page.locator('#mapRoutes').getByRole('img'),
                        20000
                    );
                },
            },
            {
                name: 'B: moveAndClick getByText FLEET first',
                run: async () => {
                    await GeneralUtils.moveAndClick(
                        page,
                        page.getByText('FLEET').first(),
                        20000
                    );
                },
            },
            {
                name: 'C: raw mouse click at FLEET element centre',
                run: async () => {
                    const box = await page
                        .getByText('FLEET')
                        .first()
                        .boundingBox();
                    if (!box) throw new Error('no bounding box');
                    await page.mouse.click(
                        box.x + box.width / 2,
                        box.y + box.height / 2
                    );
                },
            },
            {
                name: 'D: locator.click on FLEET exact',
                run: async () => {
                    await page
                        .getByText('FLEET', { exact: true })
                        .first()
                        .click({ timeout: 15000 });
                },
            },
            {
                name: 'E: moveAndClick #mapRoutes container (not img)',
                run: async () => {
                    await GeneralUtils.moveAndClick(
                        page,
                        page.locator('#mapRoutes'),
                        20000
                    );
                },
            },
        ];

        let openedBy = '';
        for (const a of attempts) {
            const before = await panelState(page);
            if (before.routesHits.length > 0) {
                openedBy = openedBy || 'already open before this attempt';
                break;
            }
            log(`Attempt ${a.name} ...`);
            await a
                .run()
                .catch((e) =>
                    log(`Attempt ${a.name} threw: ${String(e).slice(0, 200)}`)
                );
            await page.waitForTimeout(5000);
            const after = await panelState(page);
            log(`After ${a.name}: ${JSON.stringify(after)}`);
            if (after.routesHits.length > 0) {
                openedBy = a.name;
                break;
            }
        }
        summary.openedBy = openedBy;
        log('Opened by: ' + (openedBy || 'NONE'));

        if (openedBy) {
            // 3) Header counts read straight off the tab buttons
            // (v3: Routes button textContent is "Routes(216)" with the
            // count split by a <br>; Pending/Parked counts live in
            // #hPending / #hParked spans).
            const header = await page.evaluate(() => {
                const btns = Array.from(
                    document.querySelectorAll('.listBtns')
                ).map((e) => ({
                    tag: e.tagName,
                    id: e.id || '',
                    cls: String(e.className || '').slice(0, 60),
                    text: (e.textContent || '')
                        .replace(/\s+/g, ' ')
                        .trim(),
                }));
                const spans: Record<string, string> = {};
                for (const id of ['hPending', 'hParked', 'hFleet', 'hRoutes']) {
                    const el = document.getElementById(id);
                    if (el) spans[id] = (el.textContent || '').trim();
                }
                return { btns, spans };
            });
            log('Header buttons/spans: ' + JSON.stringify(header));
            summary.header = header;

            const depHtml = await page.evaluate(() => {
                const el = document.querySelector('#departAll');
                return el ? (el.outerHTML || '').slice(0, 2000) : '';
            });
            writeFile('depart-all.html', depHtml);
            log('#departAll outerHTML written (' + depHtml.length + ' chars).');

            // Full popup structure, uncapped (v3's 4000-char slice cut
            // off before the list area). Root = ancestor of the list
            // container that also holds the tab buttons.
            const popupHtml = await page.evaluate(() => {
                let root: Element | null =
                    document.querySelector('#routesContainer');
                while (
                    root &&
                    !(root.querySelector && root.querySelector('.listBtns'))
                ) {
                    root = root.parentElement;
                }
                if (!root) {
                    const btn = document.querySelector('.listBtns');
                    root = btn ? btn.parentElement : null;
                }
                return root ? (root.outerHTML || '').slice(0, 120000) : '';
            });
            writeFile('popup-structure.html', popupHtml);
            log('Popup structure written (' + popupHtml.length + ' chars).');

            // 4) Per tab: click the real .listBtns button, wait for the
            // Ajax list to settle, dump the LIST container (text +
            // HTML), then scroll it and dump again (virtualisation
            // check).
            for (const tab of ['Routes', 'Pending', 'Fleet', 'Parked']) {
                const btn = page
                    .locator('.listBtns', { hasText: tab })
                    .first();
                const btnText = await btn
                    .textContent()
                    .catch(() => '');
                await btn
                    .click({ timeout: 10000 })
                    .catch((e) =>
                        log(`Tab ${tab} button click failed: ${String(e).slice(0, 120)}`)
                    );
                log(`Tab ${tab}: clicked button "${(btnText || '').replace(/\s+/g, ' ').trim()}"`);

                let desc: any = null;
                let lastLen = -1;
                for (let s = 0; s < 15; s++) {
                    await page.waitForTimeout(1000);
                    desc = await markListContainer(page).catch(() => null);
                    const len = desc ? desc.len : -1;
                    if (len > 200 && len === lastLen) break;
                    lastLen = len;
                }
                log(`Tab ${tab}: list container = ${JSON.stringify(desc)}`);
                if (!desc) {
                    summary['tab_' + tab] = { error: 'no list container found' };
                    continue;
                }
                const dump = await page.evaluate(() => {
                    const el = document.querySelector(
                        '[data-recon-target]'
                    ) as HTMLElement | null;
                    if (!el) return { text: '', html: '' };
                    return {
                        text: el.innerText,
                        html: (el.outerHTML || '').slice(0, 60000),
                    };
                });
                writeFile(`tab-${tab.toLowerCase()}-list.txt`, dump.text);
                writeFile(`tab-${tab.toLowerCase()}-list.html`, dump.html);
                const demandCount = (dump.text.match(/Demand:/g) || []).length;
                const regCount = (dump.text.match(/B-\d+/g) || []).length;

                const scrolled = await page.evaluate(async () => {
                    const el = document.querySelector(
                        '[data-recon-target]'
                    ) as HTMLElement | null;
                    if (!el) return '';
                    for (let i = 1; i <= 4; i++) {
                        el.scrollTop = (el.scrollHeight / 4) * i;
                        await new Promise((r) => setTimeout(r, 700));
                    }
                    return el.innerText;
                });
                writeFile(`tab-${tab.toLowerCase()}-list2.txt`, scrolled);
                log(
                    `Tab ${tab}: list ${dump.text.length} chars (Demand: x${demandCount}, B-regs x${regCount}), after scroll ${scrolled.length} chars. Head: ` +
                        dump.text.replace(/\s+/g, ' ').slice(0, 200)
                );
                summary['tab_' + tab] = {
                    container: desc,
                    listLen: dump.text.length,
                    list2Len: scrolled.length,
                    demandCount,
                    regCount,
                };
            }
        }
    } catch (e) {
        log('Recon aborted with: ' + String(e).slice(0, 300));
        summary.aborted = String(e).slice(0, 300);
    }
    writeFile('summary.json', JSON.stringify(summary, null, 2));
    log('Done.');
});
