import { useEffect, useMemo, useRef, useState } from 'react';
import * as Debug from '../../core/debug';
import { type DepGraphSnapshot, getDepGraphVersion, snapshotDepGraph } from '../../core/capture/dep-graph';
import type { ClientRoom } from '../rooms';
import { availableDebugTabs, type DebugTab, useClient } from './client-store';
import { UILayer } from '../ui-layers';
import DepsGraph from './deps-graph';

// ─── shared widget chrome (used by logs/deps tabs) ──────────────────────────

const widgetStyle = (extra: React.CSSProperties): React.CSSProperties => ({
    background: 'rgba(17,17,17,0.9)',
    border: '1px solid #333',
    borderRadius: 4,
    overflow: 'hidden',
    pointerEvents: 'auto',
    fontFamily: 'Helvetica,Arial,sans-serif',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    ...extra,
});

// ─── PerfCanvas — entire perf tab body rendered in one canvas ───────────────
//
// Previously every metric had its own <canvas> + rAF loop, and the scroll
// effect used drawImage(canvas, canvas, …) per row per frame. With dozens
// of rows that thrashed the panel itself. Now: one canvas, one rAF gated to
// ~10Hz, everything (top strip + sparklines) painted in a single pass.
// Scroll & collapse state lives in refs so the redraw loop doesn't go
// through React.

const TOP_H = 80;
const GAP = 8;
const COL_TITLE_H = 22;
const SECTION_H = 18;
const ROW_H = 44;
const SCROLLBAR_W = 4;
const DRAW_INTERVAL_MS = 100;
const SMOOTH_SAMPLES_TICK = 30; // ~500ms at 60Hz
const SMOOTH_SAMPLES_NET = 60; // ~1s at 60Hz

type MetricFilter = (id: string) => boolean;
const isNetMetric: MetricFilter = (id) => id.startsWith('net/in/') || id.startsWith('net/out/');
const isCpuMetric: MetricFilter = (id) => !id.startsWith('net/');

type Scope = {
    key: string;
    label: string;
    active: boolean;
    metrics: Debug.Metrics;
};

type HitRegion = { x: number; y: number; w: number; h: number; toggleKey: string };
type ScrollRegion = { x: number; y: number; w: number; h: number; column: 'net' | 'cpu' };

type GraphCfg = {
    fg: string;
    bg: string;
    barRatio: (value: number, peak: number) => number;
    /** label for the last/min/avg/max numbers. */
    format: (value: number) => string;
};

const MS_CFG: GraphCfg = {
    fg: '#0f0',
    bg: '#020',
    barRatio: (v) => Math.min(v / 16.67, 1),
    format: (v) => `${v.toFixed(2)} ms`,
};
const KBS_CFG: GraphCfg = {
    fg: '#0af',
    bg: '#002',
    barRatio: (v, peak) => v / Math.max(peak, 1),
    format: (v) => `${v.toFixed(1)} kb/s`,
};
const PCT_CFG: GraphCfg = {
    fg: '#fc6',
    bg: '#220',
    barRatio: (v) => Math.min(v / 100, 1),
    format: (v) => `${v.toFixed(1)}%`,
};
const COUNT_CFG: GraphCfg = {
    fg: '#0af',
    bg: '#002',
    barRatio: (v, peak) => v / Math.max(peak, 1),
    format: (v) => v.toFixed(0),
};

/** unit → graph config. unknown units fall back to MS so unlabeled timers
 *  keep working. add new units here when introduced. */
const UNIT_CFG: Record<string, GraphCfg> = {
    ms: MS_CFG,
    'kb/s': KBS_CFG,
    '%': PCT_CFG,
    count: COUNT_CFG,
};

function cfgForUnit(unit: string): GraphCfg {
    return UNIT_CFG[unit] ?? MS_CFG;
}

function smoothedAvg(metrics: Debug.Metrics | null | undefined, id: string, count: number): number {
    if (!metrics) return 0;
    const values = Debug.getValues(metrics, id);
    if (!values || values.length === 0) return 0;
    const start = Math.max(0, values.length - count);
    let sum = 0;
    for (let i = start; i < values.length; i++) sum += values[i]!;
    return sum / (values.length - start);
}

type PerfData = {
    clientGlobal: Debug.Metrics | null;
    activeRoom: ClientRoom | null;
    allRooms: ClientRoom[];
};

type DrawState = {
    collapsed: Set<string>;
    scroll: { net: number; cpu: number };
    hits: HitRegion[];
    scrollRegions: ScrollRegion[];
    lastDraw: number;
};

function PerfCanvas({ view }: { view: 'summary' | 'cpu' | 'net' }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const rooms = useClient((s) => s.rooms);
    const activePlayerId = useClient((s) => s.activePlayerId);
    const allRooms = useMemo(() => [...rooms.values()], [rooms]);
    const activeRoom = activePlayerId != null ? (rooms.get(activePlayerId) ?? null) : null;
    const clientGlobal = useClient((s) => s.clientGlobalMetrics);

    // mirror reactive data into a ref so the rAF loop sees the latest
    // without restarting the effect on every store update.
    const dataRef = useRef<PerfData>({ clientGlobal, activeRoom, allRooms });
    dataRef.current = { clientGlobal, activeRoom, allRooms };
    const viewRef = useRef(view);
    viewRef.current = view;

    const stateRef = useRef<DrawState>({
        collapsed: new Set(),
        scroll: { net: 0, cpu: 0 },
        hits: [],
        scrollRegions: [],
        lastDraw: 0,
    });

    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let raf = 0;
        const tick = () => {
            raf = requestAnimationFrame(tick);
            const now = performance.now();
            if (now - stateRef.current.lastDraw < DRAW_INTERVAL_MS) return;
            stateRef.current.lastDraw = now;
            drawPerf(canvas, ctx, container, dataRef.current, stateRef.current, viewRef.current);
        };
        raf = requestAnimationFrame(tick);

        const onWheel = (e: WheelEvent) => {
            const region = pickScrollRegion(e.offsetX, e.offsetY, stateRef.current.scrollRegions);
            if (!region) return;
            e.preventDefault();
            const s = stateRef.current.scroll;
            s[region.column] = Math.max(0, s[region.column] + e.deltaY);
            stateRef.current.lastDraw = 0;
        };
        const onClick = (e: MouseEvent) => {
            for (const h of stateRef.current.hits) {
                if (e.offsetX >= h.x && e.offsetX < h.x + h.w && e.offsetY >= h.y && e.offsetY < h.y + h.h) {
                    const col = stateRef.current.collapsed;
                    if (col.has(h.toggleKey)) col.delete(h.toggleKey);
                    else col.add(h.toggleKey);
                    stateRef.current.lastDraw = 0;
                    return;
                }
            }
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('click', onClick);

        return () => {
            cancelAnimationFrame(raf);
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('click', onClick);
        };
    }, []);

    return (
        <div
            ref={containerRef}
            style={{
                flex: '1 1 auto',
                minHeight: 0,
                position: 'relative',
                pointerEvents: 'auto',
            }}
        >
            <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
        </div>
    );
}

function pickScrollRegion(x: number, y: number, regions: ScrollRegion[]): ScrollRegion | null {
    for (const r of regions) {
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
    }
    return null;
}

function buildScopes(data: PerfData): Scope[] {
    const scopes: Scope[] = [];
    if (data.clientGlobal) {
        scopes.push({
            key: 'client-global',
            label: 'client (global)',
            active: true,
            metrics: data.clientGlobal,
        });
    }
    for (const room of data.allRooms) {
        const active = room === data.activeRoom;
        const tag = `${room.roomId} · ${room.playerMode}${active ? ' (active)' : ''}`;
        scopes.push({
            key: `${room.playerId}:client`,
            label: `${tag} · client`,
            active,
            metrics: room.clientMetrics,
        });
        scopes.push({
            key: `${room.playerId}:server`,
            label: `${tag} · server`,
            active,
            metrics: room.serverMetrics,
        });
    }
    return scopes;
}

function drawPerf(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    container: HTMLDivElement,
    data: PerfData,
    state: DrawState,
    view: 'summary' | 'cpu' | 'net',
): void {
    const pr = Math.round(window.devicePixelRatio || 1);
    const cssW = container.clientWidth;
    const cssH = container.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const bw = Math.round(cssW * pr);
    const bh = Math.round(cssH * pr);
    if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
    }
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    state.hits.length = 0;
    state.scrollRegions.length = 0;

    if (view === 'summary') {
        // 'summary' tab — widgets along the top: the frame-time square + strip.
        drawFrameSquare(ctx, 0, 0, TOP_H, TOP_H, data.clientGlobal);
        drawSummaryStrip(ctx, TOP_H + GAP, 0, cssW - (TOP_H + GAP), TOP_H, data);
        return;
    }

    // 'perf' = cpu breakdown, 'net' = net breakdown — one full-width column.
    const scopes = buildScopes(data);
    if (view === 'net') drawColumn(ctx, 0, 0, cssW, cssH, 'net breakdown', isNetMetric, scopes, state, 'net');
    else drawColumn(ctx, 0, 0, cssW, cssH, 'cpu breakdown', isCpuMetric, scopes, state, 'cpu');
}

function drawPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = 'rgba(17,17,17,0.9)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function drawFrameSquare(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    clientGlobal: Debug.Metrics | null,
): void {
    drawPanel(ctx, x, y, w, h);
    const frameMs = smoothedAvg(clientGlobal, 'tick', SMOOTH_SAMPLES_TICK);
    const tone = frameMs <= 17 ? '#0f0' : frameMs <= 33 ? '#ff0' : '#f55';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = tone;
    ctx.font = 'bold 22px monospace';
    ctx.fillText(frameMs.toFixed(1), x + w / 2, y + h / 2 - 6);
    ctx.fillStyle = '#888';
    ctx.font = '9px Helvetica,Arial,sans-serif';
    ctx.fillText('ms / frame', x + w / 2, y + h / 2 + 16);
    ctx.textAlign = 'left';
}

function drawSummaryStrip(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, data: PerfData): void {
    drawPanel(ctx, x, y, w, h);
    const cells: { label: string; value: string; unit: string }[] = [
        { label: 'client tick', value: smoothedAvg(data.clientGlobal, 'tick', SMOOTH_SAMPLES_TICK).toFixed(1), unit: 'ms' },
        {
            label: 'server tick',
            value: smoothedAvg(data.activeRoom?.serverMetrics, 'tick', SMOOTH_SAMPLES_TICK).toFixed(1),
            unit: 'ms',
        },
        {
            label: 'client in',
            value: smoothedAvg(data.activeRoom?.clientMetrics, 'net/ingress', SMOOTH_SAMPLES_NET).toFixed(1),
            unit: 'kb/s',
        },
        {
            label: 'client out',
            value: smoothedAvg(data.activeRoom?.clientMetrics, 'net/egress', SMOOTH_SAMPLES_NET).toFixed(1),
            unit: 'kb/s',
        },
        {
            label: 'server in',
            value: smoothedAvg(data.activeRoom?.serverMetrics, 'net/ingress', SMOOTH_SAMPLES_NET).toFixed(1),
            unit: 'kb/s',
        },
        {
            label: 'server out',
            value: smoothedAvg(data.activeRoom?.serverMetrics, 'net/egress', SMOOTH_SAMPLES_NET).toFixed(1),
            unit: 'kb/s',
        },
    ];
    const cellStride = Math.max(110, (w - 28) / cells.length);
    let cx = x + 14;
    const cy = y + h / 2;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    for (const cell of cells) {
        ctx.fillStyle = '#888';
        ctx.font = '9px Helvetica,Arial,sans-serif';
        ctx.fillText(cell.label, cx, cy - 4);
        ctx.fillStyle = '#ccc';
        ctx.font = 'bold 13px monospace';
        ctx.fillText(cell.value, cx, cy + 14);
        const valWidth = ctx.measureText(cell.value).width;
        ctx.fillStyle = '#666';
        ctx.font = '9px monospace';
        ctx.fillText(cell.unit, cx + valWidth + 4, cy + 14);
        cx += cellStride;
    }
}

function drawColumn(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    title: string,
    filter: MetricFilter,
    scopes: Scope[],
    state: DrawState,
    column: 'net' | 'cpu',
): void {
    drawPanel(ctx, x, y, w, h);

    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(x, y, w, COL_TITLE_H);
    ctx.fillStyle = '#333';
    ctx.fillRect(x, y + COL_TITLE_H - 1, w, 1);
    ctx.fillStyle = '#ccc';
    ctx.font = 'bold 11px Helvetica,Arial,sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(title, x + 8, y + COL_TITLE_H / 2);

    const rx = x;
    const ry = y + COL_TITLE_H;
    const rw = w;
    const rh = h - COL_TITLE_H;
    state.scrollRegions.push({ x: rx, y: ry, w: rw, h: rh, column });

    type RowItem = { kind: 'header'; scope: Scope; count: number } | { kind: 'metric'; scope: Scope; id: string };
    const rows: RowItem[] = [];
    let total = 0;
    for (const scope of scopes) {
        const ids = Debug.getIds(scope.metrics).filter(filter).sort();
        rows.push({ kind: 'header', scope, count: ids.length });
        total += SECTION_H;
        if (!state.collapsed.has(scope.key)) {
            for (const id of ids) {
                rows.push({ kind: 'metric', scope, id });
                total += ROW_H;
            }
        }
    }

    const maxScroll = Math.max(0, total - rh);
    if (state.scroll[column] > maxScroll) state.scroll[column] = maxScroll;
    const scrollY = state.scroll[column];

    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();

    let cy = ry - scrollY;
    for (const row of rows) {
        if (row.kind === 'header') {
            if (cy + SECTION_H > ry && cy < ry + rh) {
                drawSectionHeader(ctx, rx, cy, rw, SECTION_H, row.scope, row.count, state);
                const hitY = Math.max(ry, cy);
                const hitH = Math.min(SECTION_H, ry + rh - hitY);
                if (hitH > 0) {
                    state.hits.push({ x: rx, y: hitY, w: rw, h: hitH, toggleKey: row.scope.key });
                }
            }
            cy += SECTION_H;
        } else {
            if (cy + ROW_H > ry && cy < ry + rh) {
                drawMetricRow(ctx, rx, cy, rw, ROW_H, row.id, row.scope.metrics);
            }
            cy += ROW_H;
        }
    }

    ctx.restore();

    if (maxScroll > 0) {
        const thumbH = Math.max(20, (rh / total) * rh);
        const thumbY = ry + (scrollY / maxScroll) * (rh - thumbH);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(rx + rw - SCROLLBAR_W - 2, thumbY, SCROLLBAR_W, thumbH);
    }
}

function drawSectionHeader(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    scope: Scope,
    count: number,
    state: DrawState,
): void {
    ctx.fillStyle = scope.active ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#222';
    ctx.fillRect(x, y + h - 1, w, 1);

    const open = !state.collapsed.has(scope.key);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#888';
    ctx.font = 'bold 10px Helvetica,Arial,sans-serif';
    ctx.fillText(open ? '▾' : '▸', x + 6, y + h / 2);

    ctx.fillStyle = scope.active ? '#fff' : '#aaa';
    ctx.fillText(scope.label, x + 20, y + h / 2);

    const labelW = ctx.measureText(scope.label).width;
    ctx.fillStyle = '#555';
    ctx.fillText(`(${count})`, x + 26 + labelW, y + h / 2);
}

function drawMetricRow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    id: string,
    metrics: Debug.Metrics,
): void {
    const unit = Debug.getUnit(metrics, id);
    const cfg = cfgForUnit(unit);
    const values = Debug.getValues(metrics, id) ?? [];
    const last = values.length > 0 ? values[values.length - 1]! : 0;
    let min = last;
    let max = last;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    const avg = values.length > 0 ? sum / values.length : 0;

    ctx.font = '9px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#888';
    ctx.fillText(id, x + 8, y + 8);

    // header, right-aligned: current value (bright) at the far right, with labeled
    // min/avg/max (dim, smaller) to its left — both up here so the graph stays clean.
    const valText = cfg.format(last);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#eee';
    ctx.fillText(valText, x + w - 10, y + 8);
    const valW = ctx.measureText(valText).width; // measured at 9px, before the font shrink
    ctx.font = '8px monospace';
    ctx.fillStyle = '#aaa';
    ctx.fillText(`min ${cfg.format(min)}  avg ${cfg.format(avg)}  max ${cfg.format(max)}`, x + w - 16 - valW, y + 8);

    const gx = x + 8;
    const gy = y + 14;
    const gw = w - 16;
    const gh = h - 18;
    ctx.fillStyle = cfg.bg;
    ctx.fillRect(gx, gy, gw, gh);
    if (values.length === 0) return;

    // draw the FULL retained window (~10s), bucketed to the graph width so a
    // longer history fits — one bar per ~pixel, each the MAX of its bucket so
    // spikes stay visible even when many samples collapse into one bar.
    const peak = max || 1;
    const barCount = Math.max(1, Math.min(values.length, Math.floor(gw)));
    const barW = gw / barCount;
    const perBar = values.length / barCount;
    ctx.fillStyle = cfg.fg;
    for (let i = 0; i < barCount; i++) {
        const start = Math.floor(i * perBar);
        const end = Math.max(start + 1, Math.floor((i + 1) * perBar));
        let v = 0;
        for (let j = start; j < end && j < values.length; j++) if (values[j]! > v) v = values[j]!;
        const ratio = cfg.barRatio(v, peak);
        const bh = Math.max(1, ratio * gh);
        ctx.fillRect(gx + i * barW, gy + gh - bh, Math.max(1, barW - 0.5), bh);
    }
}

// ─── log column (virtualized) ────────────────────────────────────────────────

const LOG_ROW_H = 14;
const LOG_OVERSCAN = 6;

/** subscribe to a Logs buffer at rAF cadence. returns a version int that
 *  bumps whenever new entries arrive — components read `logs.entries`
 *  directly in render to avoid copying the buffer each tick. */
function useLogsVersion(logs: Debug.Logs | null | undefined): number {
    const [version, setVersion] = useState(0);
    const lastRef = useRef(-1);

    useEffect(() => {
        if (!logs) return;
        lastRef.current = -1;
        let raf = 0;
        const tick = () => {
            if (logs.pushed !== lastRef.current) {
                lastRef.current = logs.pushed;
                setVersion((v) => v + 1);
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [logs]);

    return version;
}

function levelColor(level: Debug.LogLevel): string {
    if (level === 'error') return '#f66';
    if (level === 'warn') return '#fc6';
    return '#cdd';
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function LogColumn({ label, logs }: { label: string; logs: Debug.Logs | null }) {
    useLogsVersion(logs);
    const entries = logs?.entries ?? [];
    const total = entries.length;

    const scrollRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(0);
    const stickRef = useRef(true);

    // measure viewport
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
        ro.observe(el);
        setViewportH(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    // auto-scroll: when sticky and new entries arrived, jam scroll to bottom
    useEffect(() => {
        if (!stickRef.current) return;
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    });

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 4;
        stickRef.current = atBottom;
        setScrollTop(el.scrollTop);
    };

    const visibleCount = Math.ceil(viewportH / LOG_ROW_H);
    const startIdx = Math.max(0, Math.floor(scrollTop / LOG_ROW_H) - LOG_OVERSCAN);
    const endIdx = Math.min(total, startIdx + visibleCount + LOG_OVERSCAN * 2);
    const visible = entries.slice(startIdx, endIdx);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0 }}>
            <div
                style={{
                    font: 'bold 10px Helvetica,Arial,sans-serif',
                    color: '#aaa',
                    padding: '4px 8px',
                    borderBottom: '1px solid #333',
                    background: 'rgba(255,255,255,0.04)',
                    flex: '0 0 auto',
                }}
            >
                {label} <span style={{ color: '#666' }}>· {total}</span>
            </div>
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                style={{
                    overflowY: 'auto',
                    flex: '1 1 auto',
                    font: `11px / ${LOG_ROW_H}px monospace`,
                }}
            >
                {total === 0 && (
                    <div style={{ font: '9px Helvetica,Arial,sans-serif', color: '#555', padding: '6px 8px' }}>no logs</div>
                )}
                {total > 0 && (
                    <div style={{ height: total * LOG_ROW_H, position: 'relative' }}>
                        <div style={{ position: 'absolute', top: startIdx * LOG_ROW_H, left: 0, right: 0 }}>
                            {visible.map((entry, i) => {
                                const tag = entry.source ? `[${entry.source.traitId}#${entry.source.nodeId}]` : '[engine]';
                                return (
                                    <div
                                        key={startIdx + i}
                                        style={{
                                            height: LOG_ROW_H,
                                            padding: '0 8px',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            color: levelColor(entry.level),
                                        }}
                                        title={entry.msg}
                                    >
                                        <span style={{ color: '#666' }}>{formatTime(entry.ts)} </span>
                                        <span style={{ color: '#88a' }}>{tag} </span>
                                        {entry.msg}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── LogsRow — middle row: client + server log columns ──────────────────────

function LogsRow({ activeRoom }: { activeRoom: ClientRoom | null }) {
    const clientLogs = activeRoom?.clientLogs ?? null;
    const serverLogs = activeRoom?.serverLogs ?? null;

    return (
        <div style={{ display: 'flex', flexDirection: 'row', gap: 8, flex: '1 1 0', minHeight: 0 }}>
            <div style={widgetStyle({ flex: '1 1 0', minWidth: 0 })}>
                <LogColumn label="client" logs={clientLogs} />
            </div>
            <div style={widgetStyle({ flex: '1 1 0', minWidth: 0 })}>
                <LogColumn label="server" logs={serverLogs} />
            </div>
        </div>
    );
}

// ─── DepsTab ─────────────────────────────────────────────────────────────────

/** Tail the DepGraph version counter at rAF cadence. Cheap (read one int)
 *  so we can poll instead of pushing a subscribe channel out of the graph. */
function useDepGraphSnapshot(): DepGraphSnapshot {
    const [snapshot, setSnapshot] = useState<DepGraphSnapshot>(() => snapshotDepGraph());
    const lastVer = useRef(snapshot.version);

    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const v = getDepGraphVersion();
            if (v !== lastVer.current) {
                lastVer.current = v;
                setSnapshot(snapshotDepGraph());
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);

    return snapshot;
}

function depKey(registry: string, id: string): string {
    return `${registry}:${id}`;
}

function DepsList({
    snapshot,
    selected,
    onSelect,
}: {
    snapshot: DepGraphSnapshot;
    selected: string | null;
    onSelect: (key: string | null) => void;
}) {
    const grouped = useMemo(() => {
        const byReg = new Map<string, string[]>();
        for (const n of snapshot.nodes) {
            let arr = byReg.get(n.registry);
            if (!arr) {
                arr = [];
                byReg.set(n.registry, arr);
            }
            arr.push(n.id);
        }
        for (const arr of byReg.values()) arr.sort();
        return Array.from(byReg.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [snapshot]);

    return (
        <div style={{ overflowY: 'auto', flex: '1 1 auto', display: 'flex', flexDirection: 'row', gap: 0 }}>
            {grouped.map(([registry, ids]) => (
                <div key={registry} style={{ flex: '1 1 0', minWidth: 0, borderRight: '1px solid #222' }}>
                    <div
                        style={{
                            font: 'bold 10px Helvetica,Arial,sans-serif',
                            color: '#aaa',
                            padding: '4px 8px',
                            borderBottom: '1px solid #333',
                            background: 'rgba(255,255,255,0.04)',
                            position: 'sticky',
                            top: 0,
                        }}
                    >
                        {registry} <span style={{ color: '#555' }}>· {ids.length}</span>
                    </div>
                    {ids.map((id) => {
                        const key = depKey(registry, id);
                        const isSel = key === selected;
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => onSelect(isSel ? null : key)}
                                style={{
                                    display: 'block',
                                    width: '100%',
                                    textAlign: 'left',
                                    font: '10px monospace',
                                    color: isSel ? '#000' : '#ccc',
                                    background: isSel ? '#fc6' : 'transparent',
                                    border: 0,
                                    padding: '2px 8px',
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                }}
                            >
                                {id}
                            </button>
                        );
                    })}
                </div>
            ))}
            {grouped.length === 0 && (
                <div style={{ font: '9px Helvetica,Arial,sans-serif', color: '#555', padding: '6px' }}>
                    no dependencies registered yet
                </div>
            )}
        </div>
    );
}

function DepsTab() {
    const snapshot = useDepGraphSnapshot();
    const [selected, setSelected] = useState<string | null>(null);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, gap: 8 }}>
            {/* top — registry columns, click to select */}
            <div style={widgetStyle({ flex: '1 1 0', minHeight: 0, flexDirection: 'column' })}>
                <DepsList snapshot={snapshot} selected={selected} onSelect={setSelected} />
            </div>
            {/* bottom — selected node's neighborhood (producers ← selected → consumers) */}
            <div style={widgetStyle({ flex: '1 1 0', minHeight: 0, padding: 0 })}>
                <DepsGraph snapshot={snapshot} selected={selected} onSelect={setSelected} />
            </div>
        </div>
    );
}

// ─── Tab strip ───────────────────────────────────────────────────────────────

function TabStrip({ tab, onSelect }: { tab: DebugTab; onSelect: (t: DebugTab) => void }) {
    const tabs = availableDebugTabs();
    return (
        <div
            style={widgetStyle({
                flexDirection: 'row',
                gap: 0,
                padding: 0,
                flex: '0 0 auto',
                pointerEvents: 'auto',
            })}
        >
            {tabs.map((t, i) => {
                const isSel = t === tab;
                return (
                    <button
                        key={t}
                        type="button"
                        onClick={() => onSelect(t)}
                        style={{
                            flex: '0 0 auto',
                            font: `bold 10px Helvetica,Arial,sans-serif`,
                            color: isSel ? '#000' : '#ccc',
                            background: isSel ? '#fc6' : 'transparent',
                            border: 0,
                            borderRight: '1px solid #333',
                            padding: '6px 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                        }}
                    >
                        <span style={{ color: isSel ? '#000' : '#888', font: 'bold 9px monospace' }}>{i + 1}</span>
                        <span>{t}</span>
                    </button>
                );
            })}
        </div>
    );
}

// ─── DebugPanel — fullscreen dashboard ───────────────────────────────────────
//
// Default export so ui.tsx can `lazy(() => import('./debug-panel'))` — the
// whole panel (all tabs, xyflow, dagre, log virtualization, metrics
// widgets) lives in one chunk that only loads after the user opens it.

export default function DebugPanel({ tab }: { tab: DebugTab }) {
    const rooms = useClient((s) => s.rooms);
    const activePlayerId = useClient((s) => s.activePlayerId);
    const activeRoom = activePlayerId != null ? (rooms.get(activePlayerId) ?? null) : null;
    const setDebugTab = useClient((s) => s.setDebugTab);

    return (
        <div
            style={{
                position: 'absolute',
                inset: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                pointerEvents: 'none',
                zIndex: UILayer.debug, // above hud/touch/world overlays under the viewport
                overflow: 'hidden',
            }}
        >
            <TabStrip tab={tab} onSelect={setDebugTab} />

            {tab === 'summary' && <PerfCanvas view="summary" />}
            {tab === 'perf' && <PerfCanvas view="cpu" />}
            {tab === 'net' && <PerfCanvas view="net" />}
            {tab === 'logs' && <LogsRow activeRoom={activeRoom} />}
            {tab === 'deps' && <DepsTab />}
            {/* renderer tab: panel body is empty — gpucat Inspector overlay
                is the actual surface, mounted directly on the canvas. */}
        </div>
    );
}
