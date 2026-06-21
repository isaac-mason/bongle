// ── debug ───────────────────────────────────────────────────────────
//
// engine debug primitives. owns two data types today:
//   - Metrics: numeric series (begin/end timers, recorded values)
//   - Logs:    ring buffer of structured log entries from scripts and
//              engine-internal console wraps
//
// future home for shared transport orchestration (subscribe / push)
// once the metrics poll is replaced with push. for now both Metrics
// and Logs are pure local-state collectors — the protocol still polls.

const MAX_HISTORY = 600; // ~10s at 60Hz — enough history to read trends/spikes in the panel

// ── metrics ─────────────────────────────────────────────────────────

type MetricEntry = {
    values: number[];
    beginTime: number;
    /** unit string for display in the debug panel (e.g. 'ms', 'kb/s', '%').
     *  defaults to 'ms' since timers are the common case; overridden by
     *  the `unit` arg on `record()`. once set, sticks across subsequent
     *  records to keep the entry self-describing. */
    unit: string;
};

export type Metrics = {
    entries: Map<string, MetricEntry>;
    /** when false, begin/end/record noop. used to skip per-frame timer cost on
     *  clients while the debug panel is closed — those samples would never be
     *  read. server always runs enabled (its metrics ship to the panel). */
    enabled: boolean;
};

export function createMetrics(enabled = true): Metrics {
    return {
        entries: new Map(),
        enabled,
    };
}

export function setEnabled(metrics: Metrics, enabled: boolean): void {
    metrics.enabled = enabled;
}

function getOrCreateEntry(metrics: Metrics, id: string): MetricEntry {
    let entry = metrics.entries.get(id);
    if (!entry) {
        entry = { values: [], beginTime: 0, unit: 'ms' };
        metrics.entries.set(id, entry);
    }
    return entry;
}

/** begin timing a metric */
export function begin(metrics: Metrics, id: string): void {
    if (!metrics.enabled) return;
    const entry = getOrCreateEntry(metrics, id);
    entry.beginTime = (typeof performance !== 'undefined' ? performance : Date).now();
}

/** end timing a metric, returns the measured time in ms */
export function end(metrics: Metrics, id: string): number {
    if (!metrics.enabled) return 0;
    const entry = metrics.entries.get(id);
    if (!entry) {
        return 0;
    }

    const now = (typeof performance !== 'undefined' ? performance : Date).now();
    const ms = now - entry.beginTime;

    entry.values.push(ms);
    if (entry.values.length > MAX_HISTORY) {
        entry.values.shift();
    }

    return ms;
}

/** record a value directly (for receiving metrics over network or for computed values).
 *  `unit` defaults to 'ms' on first record; pass an override (e.g. 'kb/s', '%',
 *  'count') to label non-time metrics correctly in the debug panel. */
export function record(metrics: Metrics, id: string, value: number, unit?: string): void {
    if (!metrics.enabled) return;
    const entry = getOrCreateEntry(metrics, id);
    if (unit !== undefined) entry.unit = unit;
    entry.values.push(value);
    if (entry.values.length > MAX_HISTORY) {
        entry.values.shift();
    }
}

/** get the values history for a metric */
export function getValues(metrics: Metrics, id: string): number[] | undefined {
    return metrics.entries.get(id)?.values;
}

/** get the unit string for a metric. returns 'ms' for unknown ids — that's
 *  the default for any new entry, so panel rendering stays consistent. */
export function getUnit(metrics: Metrics, id: string): string {
    return metrics.entries.get(id)?.unit ?? 'ms';
}

/** get all metric ids */
export function getIds(metrics: Metrics): string[] {
    return Array.from(metrics.entries.keys());
}

/** get latest values for all metrics (for sending over network) */
export function getLatestValues(metrics: Metrics): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, entry] of metrics.entries) {
        if (entry.values.length > 0) {
            result[id] = entry.values[entry.values.length - 1]!;
        }
    }
    return result;
}

// ── logs ────────────────────────────────────────────────────────────

export type LogLevel = 'log' | 'warn' | 'error';

/**
 * source attribution for logs coming from script code. omitted for
 * engine-internal logs captured via console wraps (those are 'global').
 */
export type LogSource = {
    traitId: string;
    nodeId: number;
    nodeName: string | undefined;
    mode: 'edit' | 'play';
    side: 'client' | 'server';
};

export type LogEntry = {
    ts: number;
    level: LogLevel;
    msg: string;
    source: LogSource | undefined;
};

const LOG_DEFAULT_CAP = 2000;

export type Logs = {
    /** entries in arrival order. capped at `cap` — oldest dropped on overflow. */
    entries: LogEntry[];
    /** monotonic count of entries ever pushed. lets subscribers track a delta cursor across drops. */
    pushed: number;
    cap: number;
};

export function createLogs(cap = LOG_DEFAULT_CAP): Logs {
    return { entries: [], pushed: 0, cap };
}

export function pushLog(logs: Logs, entry: LogEntry): void {
    logs.entries.push(entry);
    logs.pushed++;
    if (logs.entries.length > logs.cap) logs.entries.shift();
}

/**
 * read entries pushed after `cursor`. returns the entries and a fresh
 * cursor to pass next call. if `cursor < pushed - entries.length`,
 * caller missed entries that fell off the buffer — `dropped` indicates
 * how many. caller can show a "… N entries dropped" marker.
 */
export function readDelta(logs: Logs, cursor: number): {
    entries: LogEntry[];
    cursor: number;
    dropped: number;
} {
    const oldest = logs.pushed - logs.entries.length;
    if (cursor >= logs.pushed) return { entries: [], cursor: logs.pushed, dropped: 0 };

    const dropped = Math.max(0, oldest - cursor);
    const startIdx = Math.max(0, cursor - oldest);
    return {
        entries: logs.entries.slice(startIdx),
        cursor: logs.pushed,
        dropped,
    };
}
