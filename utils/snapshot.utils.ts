// Fleet snapshot parsing + self-check (2026-11-18, rewritten the same
// evening against REAL panel rows captured by Fleet Recon v4, run
// 44446747315; raw evidence in the recon-review-4-2026-11-18 folder).
//
// The parsers are LINE-based state machines over the #routesContainer
// innerText (which preserves newlines). The first version's regexes
// were written against a probe's single-line transcription and parsed
// 0 of 217 real rows - never again: every shape below is copied from a
// captured real row.
//
// Real formats (whitespace-trimmed lines):
//   Routes page head:  "217 ROUTES" / "Cost index" / "Depart 3" /
//                      page number / "Next" (pagination chrome, ignored)
//   Route row (Demand):   "5,333KM" / "#CL-0013" / "WAJJ - ZBAA" /
//                         "B-06-9 - MC-21-400" / "Demand: 858 / 223 / 161" /
//                         "Depart"
//   Route row (Onboard):  "#CL-0038" / "ZBAA - VOMM" /
//                         "B-030-4 - MC-21-400" / "Onboard: 10 / 3 / 10" /
//                         "00:07:09"        (no distance line)
//   Route row (cargo):    type renders as "Boeing 777-300ERSF" and the
//                         status line is "Onboard: 130,000 / 8,000 Lbs"
//   Pending block:        "A380-800, B-237" / "276 Seats" /
//                         "Astana, Kazakhstan" /
//                         "Pending maintenance: 05:38:57"
//                         (eta may be "1d 05:16:33"; the middle line is
//                         free-form - seats today, ignored on purpose)
//   Fleet block:          "MC-21-400" / "Irkut" /
//                         "Number of aircraft: 140"
//                         (freighter type line is "Boeing 777-300ERSF"
//                         with vendor line "Boeing")
//   Parked (count 0):     "0 AIRCRAFT" / "THERE ARE NO PARKED AIRCRAFT"
//   Parked block:         "A380-800" / "255 Seats" / "B-255" /
//                         "São Paulo Guarulhos, Brazil" /
//                         "Y class: 15" / "J class: 135" /
//                         "F class: 105" / "Route" / "Details"
//                         (verified 2026-11-19 from run 44656179369's
//                         committed raw text - the first capture ever
//                         with a parked aircraft; before that only the
//                         count-0 empty state above had been seen)
//
// Self-check (must ALL pass, otherwise the snapshot is invalid and
// latest.json is left untouched):
//   1. Closure: parsed row counts equal the panel's own header counts,
//      and routes + pending + parked == fleet total.
//   2. Uniqueness: no registration appears twice across the union.
//   3. Completeness: any row-shaped block that fails to parse is
//      counted (with the REAL shapes) and fails the snapshot here.
//   4. Delta: fleet total may not jump by more than 10 vs the previous
//      valid snapshot (guards against half-rendered pages).

export interface RouteRow {
    reg: string;
    type: string;
    origin: string;
    dest: string;
    routeNo: string;
    distanceKm: number;
    onboard: boolean;
}

export interface PendingRow {
    reg: string;
    type: string;
    kind: 'delivery' | 'maintenance';
    location: string;
    etaText: string;
}

export interface HeaderCounts {
    routes: number;
    fleet: number;
    parked: number;
    pending: number;
}

export interface SnapshotData {
    takenAt: string;
    header: HeaderCounts;
    routes: RouteRow[];
    pending: PendingRow[];
    parked: { reg: string; type: string }[];
    fleetByType: Record<string, number>;
}

// The page renders the freighter as "Boeing 777-300ERSF" while the
// card table calls it "777-300ERSF"; collapsed text can also glue the
// vendor name onto the end ("MC-21-400 Irkut"). Normalise both.
export function cleanAircraftType(raw: string): string {
    let t = raw.trim();
    t = t.replace(/^Boeing\s+/, '').replace(/^Airbus\s+/, '');
    t = t.replace(/\s+(Irkut|Boeing|Airbus)$/, '');
    return t.trim();
}

function collapse(text: string): string {
    return text.replace(/\s+/g, ' ');
}

function lines(text: string): string[] {
    return text.split('\n').map((s) => s.trim());
}

export function parseHeaderCounts(panelText: string): HeaderCounts | null {
    const t = collapse(panelText);
    // Fed with the tab buttons' own text (recon v4 verified renderings:
    // "Routes(217)", "Fleet(234)", "Parked(0)", "Pending (17)").
    const grab = (name: string): number | null => {
        const m =
            new RegExp(name + '\\s*\\(\\s*(\\d+)\\s*\\)').exec(t) ||
            new RegExp(name + '\\s+(\\d+)').exec(t);
        return m ? parseInt(m[1], 10) : null;
    };
    const routes = grab('Routes');
    const fleet = grab('Fleet');
    const parked = grab('Parked');
    const pending = grab('Pending');
    if (routes === null || fleet === null || parked === null || pending === null)
        return null;
    return { routes, fleet, parked, pending };
}

const REG = '[A-Z]-[0-9][0-9A-Za-z-]*';

interface RouteScan {
    rows: RouteRow[];
    failedBlocks: number;
    // Parsed row attempts INCLUDING rows the reg dedupe dropped, and
    // the registrations that were seen more than once. A capture can
    // hold the header's full count of rows yet be one aircraft short
    // when the list shifts across a page boundary mid-paging: the
    // boundary row is read twice and the row behind it is skipped
    // (pagination drift - see analyzeRouteDrift below).
    attempts: number;
    duplicateRegs: string[];
}

function scanRoutes(panelText: string): RouteScan {
    const ls = lines(panelText);
    const rows: RouteRow[] = [];
    const seen = new Set<string>();
    const dupSeen = new Set<string>();
    const duplicateRegs: string[] = [];
    let attempts = 0;
    let failedBlocks = 0;
    let distanceKm = 0;
    for (let i = 0; i < ls.length; i++) {
        const dl = /^([\d,]+)KM$/.exec(ls[i]);
        if (dl) {
            distanceKm = parseInt(dl[1].replace(/,/g, ''), 10);
            continue;
        }
        const rm = /^#(CL-\S+)$/.exec(ls[i]);
        if (!rm)
            continue;
        const od = /^([A-Z]{4}) - ([A-Z]{4})$/.exec(ls[i + 1] || '');
        const ac = new RegExp('^(' + REG + ') - (.+)$').exec(ls[i + 2] || '');
        const status = ls[i + 3] || '';
        const isDemand = status.startsWith('Demand:');
        const isOnboard = status.startsWith('Onboard:');
        if (!od || !ac || (!isDemand && !isOnboard)) {
            failedBlocks++;
            continue;
        }
        const row: RouteRow = {
            routeNo: rm[1],
            origin: od[1],
            dest: od[2],
            reg: ac[1],
            type: cleanAircraftType(ac[2]),
            distanceKm: isOnboard ? 0 : distanceKm,
            onboard: isOnboard,
        };
        // Dedupe by REGISTRATION, never by routeNo. The #CL- number
        // is NOT unique per route: live evidence (run 44461007086's
        // committed raw text) shows #CL-0076 on ten different routes
        // and #CL-0094 on three, while registrations are unique in
        // every capture (217 rows = 217 distinct regs; a later run's
        // five passes = 213 distinct regs = the header count). The
        // old routeNo dedupe silently discarded ~30 real routes per
        // run and the closure check then rejected complete captures
        // - the true cause of the 2026-11-18 collector failures.
        attempts++;
        if (!seen.has(row.reg)) {
            seen.add(row.reg);
            rows.push(row);
        } else if (!dupSeen.has(row.reg)) {
            dupSeen.add(row.reg);
            duplicateRegs.push(row.reg);
        }
    }
    return { rows, failedBlocks, attempts, duplicateRegs };
}

export interface RouteDriftAnalysis {
    // Route rows that parsed, duplicates included.
    rawRows: number;
    // Distinct registrations after the reg dedupe.
    distinctRegs: number;
    // Registrations parsed more than once in the same capture.
    duplicateRegs: string[];
    // True when the capture's shape is pagination drift rather
    // than a genuine shortfall: at least the header's count of
    // rows was read, a registration repeats, yet the distinct
    // aircraft count is below the header - one aircraft was
    // skipped behind the duplicated boundary row.
    isDrift: boolean;
}

// Pagination-drift detection (repair-log E entry, 2026-11-26;
// spec fixed there after the third same-shape failure and first
// implemented when the fourth hit, 2026-11-27 run invalid at
// 17:22:48Z: raw 223 rows = header 223, distinct 222, B-143 read
// on both sides of a page break). Pure analysis of the captured
// text - it diagnoses, it never edits a row.
export function analyzeRouteDrift(panelText: string, headerRoutes: number): RouteDriftAnalysis {
    const scan = scanRoutes(panelText);
    const rawRows = scan.attempts;
    const distinctRegs = scan.rows.length;
    const duplicateRegs = scan.duplicateRegs;
    const isDrift =
        headerRoutes > 0 &&
        rawRows >= headerRoutes &&
        distinctRegs < headerRoutes &&
        duplicateRegs.length > 0;
    return { rawRows, distinctRegs, duplicateRegs, isDrift };
}

export function parseRoutes(panelText: string): RouteRow[] {
    return scanRoutes(panelText).rows;
}

// Count route blocks (each starts with a "#CL-" line) that failed to
// parse. Shape = the real one; the v1 counter looked for "KM # " and
// reported 0 while every row failed (false green, recon v4 finding).
export function countUnparsedRouteLines(panelText: string): number {
    return scanRoutes(panelText).failedBlocks;
}

interface PendingScan {
    rows: PendingRow[];
    failedBlocks: number;
}

function scanPending(panelText: string): PendingScan {
    const ls = lines(panelText);
    const rows: PendingRow[] = [];
    const seen = new Set<string>();
    let failedBlocks = 0;
    for (let j = 0; j < ls.length; j++) {
        const am = /^Pending (delivery|maintenance):\s*(.+)$/.exec(ls[j]);
        if (!am)
            continue;
        // Block shape: [type, reg] / free-form info / location / anchor.
        const head = new RegExp('^(.+),\\s*(' + REG + ')$').exec(ls[j - 3] || '');
        const location = (ls[j - 1] || '').trim();
        if (!head || !location) {
            failedBlocks++;
            continue;
        }
        const row: PendingRow = {
            type: cleanAircraftType(head[1]),
            reg: head[2],
            location,
            kind: am[1] as 'delivery' | 'maintenance',
            etaText: am[2].trim(),
        };
        if (!seen.has(row.reg)) {
            seen.add(row.reg);
            rows.push(row);
        }
    }
    return { rows, failedBlocks };
}

export function parsePending(panelText: string): PendingRow[] {
    return scanPending(panelText).rows;
}

export function countUnparsedPendingLines(panelText: string): number {
    return scanPending(panelText).failedBlocks;
}

// Parked rows, anchored on the seats line (see header comment for the
// verified block shape): the line directly above the seats line is the
// aircraft type, the first registration-shaped line below it is the
// aircraft. A parked freighter may render a capacity line instead of
// a seats line, so that anchors a block too. The count-0 empty state
// has neither anchor and parses to []. Before 2026-11-19 the spec
// guessed a pending-style "Type, REG" regex for this tab; run
// 44656179369 captured the real format and the closure check rightly
// rejected that run's snapshot until this parser existed.
export function parseParked(panelText: string): { reg: string; type: string }[] {
    const ls = lines(panelText);
    const rows: { reg: string; type: string }[] = [];
    const seen = new Set<string>();
    const regLine = new RegExp('^(' + REG + ')$');
    for (let i = 0; i < ls.length; i++) {
        if (!/^\d[\d,]*\s+Seats$/.test(ls[i]) && !/Capacity/i.test(ls[i]))
            continue;
        const type = cleanAircraftType(ls[i - 1] || '');
        if (!type)
            continue;
        for (let j = i + 1; j < Math.min(i + 4, ls.length); j++) {
            const m = regLine.exec(ls[j]);
            if (m) {
                if (!seen.has(m[1])) {
                    seen.add(m[1]);
                    rows.push({ type, reg: m[1] });
                }
                break;
            }
        }
    }
    return rows;
}

export function parseFleetByType(panelText: string): Record<string, number> {
    const ls = lines(panelText);
    const out: Record<string, number> = {};
    for (let i = 0; i < ls.length; i++) {
        const m = /^Number of aircraft:\s*(\d+)$/.exec(ls[i]);
        if (!m)
            continue;
        // Block shape: type line / vendor line / count line.
        const type = cleanAircraftType(ls[i - 2] || '');
        if (type)
            out[type] = parseInt(m[1], 10);
    }
    return out;
}

export interface SelfCheckResult {
    valid: boolean;
    reasons: string[];
}

export function selfCheck(
    snap: SnapshotData,
    unparsedRoutes: number,
    unparsedPending: number,
    previousFleetTotal: number | null
): SelfCheckResult {
    const reasons: string[] = [];
    const h = snap.header;

    if (snap.routes.length !== h.routes)
        reasons.push(`closure: parsed ${snap.routes.length} route rows, header says ${h.routes}`);
    if (snap.pending.length !== h.pending)
        reasons.push(`closure: parsed ${snap.pending.length} pending rows, header says ${h.pending}`);
    if (snap.parked.length !== h.parked)
        reasons.push(`closure: parsed ${snap.parked.length} parked rows, header says ${h.parked}`);
    if (snap.routes.length + snap.pending.length + snap.parked.length !== h.fleet)
        reasons.push(`closure: routes+pending+parked != fleet total ${h.fleet}`);

    const typeSum = Object.values(snap.fleetByType).reduce((a, b) => a + b, 0);
    if (Object.keys(snap.fleetByType).length > 0 && typeSum !== h.fleet)
        reasons.push(`closure: fleet-by-type sum ${typeSum} != fleet total ${h.fleet}`);

    const regs = new Set<string>();
    let dup = false;
    for (const r of [...snap.routes, ...snap.pending, ...snap.parked]) {
        if (regs.has(r.reg))
            dup = true;
        regs.add(r.reg);
    }
    if (dup)
        reasons.push('uniqueness: duplicate registration across union');

    if (unparsedRoutes > 0)
        reasons.push(`completeness: ${unparsedRoutes} route block(s) failed to parse`);
    if (unparsedPending > 0)
        reasons.push(`completeness: ${unparsedPending} pending block(s) failed to parse`);

    if (previousFleetTotal !== null && Math.abs(h.fleet - previousFleetTotal) > 10)
        reasons.push(`delta: fleet total jumped ${previousFleetTotal} -> ${h.fleet} (>10)`);

    return { valid: reasons.length === 0, reasons };
}
