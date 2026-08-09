import type { Panel, PanelOptions } from 'dashcat';
import * as Debug from '../core/debug';
import { onDispose, type ScriptContext } from '../core/scene/scripts';

/**
 * format args the way `console.log` formats them: strings pass through,
 * objects get JSON.stringify, everything else `String()`s. one level of
 * nesting is enough, log payloads should be small.
 */
function formatArgs(args: unknown[]): string {
    const out: string[] = [];
    for (const a of args) {
        if (typeof a === 'string') out.push(a);
        else if (a instanceof Error) out.push(a.stack ?? a.message);
        else if (typeof a === 'object' && a !== null) {
            try {
                out.push(JSON.stringify(a));
            } catch {
                out.push(String(a));
            }
        } else out.push(String(a));
    }
    return out.join(' ');
}

function emit(ctx: ScriptContext, level: Debug.LogLevel, args: unknown[]): void {
    const msg = formatArgs(args);
    const side: 'client' | 'server' = ctx.server ? 'server' : 'client';
    const source: Debug.LogSource = {
        traitId: ctx.trait._def.id,
        nodeId: ctx.node.id,
        nodeName: ctx.node.name,
        mode: ctx.mode,
        side,
    };
    const entry: Debug.LogEntry = { ts: Date.now(), level, msg, source };

    if (ctx.server) {
        Debug.pushLog(ctx.server.room.logs, entry);
    } else if (ctx.client?.room) {
        Debug.pushLog(ctx.client.room.clientLogs, entry);
    }

    // mirror to console for dev visibility, devtools / stdout stay useful
    // until the debug panel is fully wired up.
    const prefix = `[${source.traitId}#${source.nodeId}]`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
}

/** log an info-level message tagged with the script's trait + node. */
export function log(ctx: ScriptContext, ...args: unknown[]): void {
    emit(ctx, 'log', args);
}

/** log a warning tagged with the script's trait + node. */
export function warn(ctx: ScriptContext, ...args: unknown[]): void {
    emit(ctx, 'warn', args);
}

/** log an error tagged with the script's trait + node. */
export function error(ctx: ScriptContext, ...args: unknown[]): void {
    emit(ctx, 'error', args);
}

/**
 * open a floating debug panel on the shared dashboard, scoped to this script: it
 * is closed automatically when the script instance disposes (room teardown, node
 * removal, hot-reload), so game debug UI can't leak. the returned dashcat `Panel`
 * takes the full control surface — `add` (options), `monitor`, `graph`, `log`,
 * `stat`, `tabs`, etc. — alongside the engine's panels.
 *
 * client-only: returns `null` on the server. `title` defaults to the script's
 * trait/node tag, mirroring how `log` tags its source. for full control (or
 * manual lifecycle) reach `ctx.client.debug.dashboard` directly.
 */
export function panel(ctx: ScriptContext, opts: PanelOptions = {}): Panel | null {
    if (!ctx.client) return null;
    const title = opts.title ?? `${ctx.trait._def.id}#${ctx.node.id}`;
    const p = ctx.client.debug.dashboard.panel({ ...opts, title });
    // close() fully disposes the floating window (controls + DOM + panels[]);
    // the inherited destroy() only tears down controls, orphaning the window.
    onDispose(ctx, () => p.close());
    return p;
}
