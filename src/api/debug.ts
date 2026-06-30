import * as Debug from '../core/debug';
import type { ScriptContext } from '../core/scene/scripts';

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
