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

test.setTimeout(600000);

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

// Smallest container holding both "Routes" and "Pending" text.
async function popupText(page: Page): Promise<string> {
    return await page
        .evaluate(() => {
            const all = Array.from(document.querySelectorAll('*'));
            const c = all
                .filter((e) => {
                    const t = e.textContent || '';
                    return (
                        t.includes('Routes') &&
                        t.includes('Pending') &&
                        t.length > 200
                    );
                })
                .sort(
                    (x, y) =>
                        (x.textContent || '').length -
                        (y.textContent || '').length
                )[0];
            return c ? (c as HTMLElement).innerText : '';
        })
        .catch(() => '');
}

test('Fleet recon (read-only mapping)', async ({ page }) => {
    const summary: Record<string, unknown> = {};
    try {
        const generalUtils = new GeneralUtils(page);
        await generalUtils.login(page);
        log('Logged in. Waiting 10s for the map to settle...');
        await page.waitForTimeout(10000);

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
            // 3) Popup structure + full text of every tab.
            const popupHtml = await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('*'));
                const c = all
                    .filter((e) => {
                        const t = e.textContent || '';
                        return (
                            t.includes('Routes') &&
                            t.includes('Pending') &&
                            t.length > 200
                        );
                    })
                    .sort(
                        (x, y) =>
                            (x.textContent || '').length -
                            (y.textContent || '').length
                    )[0];
                return c ? (c.outerHTML || '').slice(0, 4000) : '';
            });
            writeFile('popup-structure.html', popupHtml);
            log('Popup structure written (' + popupHtml.length + ' chars).');

            for (const tab of ['Routes', 'Pending', 'Fleet', 'Parked']) {
                const anchored = page
                    .getByText(
                        new RegExp('^\\s*' + tab + '(\\s*\\(\\d+\\))?\\s*$')
                    )
                    .first();
                const clicked = await anchored
                    .click({ timeout: 10000 })
                    .then(() => true)
                    .catch(() => false);
                if (!clicked) {
                    await page
                        .getByText(tab)
                        .first()
                        .click({ timeout: 10000 })
                        .catch((e) =>
                            log(
                                `Tab ${tab} click failed both ways: ${String(e).slice(0, 120)}`
                            )
                        );
                }
                await page.waitForTimeout(3000);
                const text = await popupText(page);
                writeFile(`tab-${tab.toLowerCase()}.txt`, text);
                log(
                    `Tab ${tab}: ${text.length} chars written. Head: ` +
                        text.replace(/\s+/g, ' ').slice(0, 200)
                );
                summary['tab_' + tab] = text.length;
            }
        }
    } catch (e) {
        log('Recon aborted with: ' + String(e).slice(0, 300));
        summary.aborted = String(e).slice(0, 300);
    }
    writeFile('summary.json', JSON.stringify(summary, null, 2));
    log('Done.');
});
