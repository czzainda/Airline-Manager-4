// Fleet snapshot parsing + self-check (2026-11-18).
//
// Read-only collector support: turns the ROUTES panel's visible text
// (Routes / Pending / Fleet sub-tabs) into a structured snapshot and
// validates it before anything is written to snapshots/latest.json.
//
// Panel formats verified by a live read-only probe on 2026-11-18:
//   Route row:   "2,600KM # CL-135 ZUUU - VIDP B-140 - MC-21-400 Demand: 602 / 125 / 119"
//   Pending row: "A380-800, B-253 238 Seats / New Delhi, India / Pending delivery: 04:49:43"
//   Fleet tab:   "MC-21-400 Irkut Number of aircraft: 140"
//   Tab headers: names with counts (exact rendering unverified - the
//   parsers accept both "Routes (222)" and "Routes 222"; the first live
//   run, 44423513135, died waiting for the parenthesised form)
//
// Self-check (must ALL pass, otherwise the snapshot is invalid and
// latest.json is left untouched):
//   1. Closure: parsed row counts equal the panel's own header counts,
//      and routes + pending + parked == fleet total.
//   2. Uniqueness: no registration appears twice across the union.
//   3. Completeness: every parsed row carries reg + type (+ origin/dest
//      for routes, + kind for pending) by construction of the regexes;
//      any row-shaped text that fails to parse is counted and fails here.
//   4. Delta: fleet total may not jump by more than 10 vs the previous
//      valid snapshot (guards against half-rendered pages).

export interface RouteRow {
    reg: string;
    type: string;
    origin: string;
    dest: string;
    routeNo: string;
    distanceKm: number;
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

const REG = '[A-Z]-[0-9][0-9A-Za-z-]*';

function collapse(text: string): string {
    return text.replace(/\s+/g, ' ');
}

export function parseHeaderCounts(panelText: string): HeaderCounts | null {
    const t = collapse(panelText);
    // The count's exact rendering next to a tab name is unverified, so
    // accept both "Routes (222)" and "Routes 222".
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

const ROUTE_RE = new RegExp(
    '([\\d,]+)KM # (\\S+) ([A-Z]{4}) - ([A-Z]{4}) (' + REG + ') - (.+?) Demand:',
    'g'
);

export function parseRoutes(panelText: string): RouteRow[] {
    const t = collapse(panelText);
    const rows: RouteRow[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(t)) !== null) {
        const row: RouteRow = {
            distanceKm: parseInt(m[1].replace(/,/g, ''), 10),
            routeNo: m[2],
            origin: m[3],
            dest: m[4],
            reg: m[5],
            type: m[6].trim(),
        };
        // The same row can repeat across scroll captures; routeNo is
        // unique per route in this panel (probe 2026-11-18).
        if (!seen.has(row.routeNo)) {
            seen.add(row.routeNo);
            rows.push(row);
        }
    }
    return rows;
}

// Count route-shaped lines that failed to parse (completeness check).
export function countUnparsedRouteLines(panelText: string): number {
    const t = collapse(panelText);
    const shaped = (t.match(/KM # /g) || []).length;
    const parsed = (t.match(new RegExp(ROUTE_RE.source, 'g')) || []).length;
    return Math.max(0, shaped - parsed);
}

const PENDING_RE = new RegExp(
    '([A-Za-z0-9][A-Za-z0-9\\-]*)\\s*,\\s*(' + REG + ')\\s+\\d+ Seats / (.+?) / Pending (delivery|maintenance): ([0-9d :]+)',
    'g'
);

export function parsePending(panelText: string): PendingRow[] {
    const t = collapse(panelText);
    const rows: PendingRow[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    PENDING_RE.lastIndex = 0;
    while ((m = PENDING_RE.exec(t)) !== null) {
        const row: PendingRow = {
            type: m[1].trim(),
            reg: m[2],
            location: m[3].trim(),
            kind: m[4] as 'delivery' | 'maintenance',
            etaText: m[5].trim(),
        };
        if (!seen.has(row.reg)) {
            seen.add(row.reg);
            rows.push(row);
        }
    }
    return rows;
}

export function countUnparsedPendingLines(panelText: string): number {
    const t = collapse(panelText);
    const shaped = (t.match(/Pending (delivery|maintenance):/g) || []).length;
    const parsed = (t.match(new RegExp(PENDING_RE.source, 'g')) || []).length;
    return Math.max(0, shaped - parsed);
}

export function parseFleetByType(panelText: string): Record<string, number> {
    const t = collapse(panelText);
    const out: Record<string, number> = {};
    const re = /([A-Za-z0-9][A-Za-z0-9\- ]*?) Number of aircraft: (\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
        out[m[1].trim()] = parseInt(m[2], 10);
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
        reasons.push(`completeness: ${unparsedRoutes} route-shaped line(s) failed to parse`);
    if (unparsedPending > 0)
        reasons.push(`completeness: ${unparsedPending} pending-shaped line(s) failed to parse`);

    if (previousFleetTotal !== null && Math.abs(h.fleet - previousFleetTotal) > 10)
        reasons.push(`delta: fleet total jumped ${previousFleetTotal} -> ${h.fleet} (>10)`);

    return { valid: reasons.length === 0, reasons };
}
