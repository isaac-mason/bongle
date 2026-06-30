/**
 * format + log an error thrown from a user-authored callback.
 *
 * compose `where` to identify the call site, e.g.
 *     `script '${id}'.onTick @${nodeId}`
 *     `prefab '${id}'.apply @${nodeId}`
 *     `trait '${id}'.onChange[${field}] @${nodeId}`
 *
 * scope: runtime callbacks only. module-load throws and top-level async
 * errors (timers/microtasks scheduled at module scope) are out of reach,
 * the host app owns import().
 */
export function logScriptError(where: string, err: unknown): void {
    console.error(`[bongle] ${where}:`, err);
}
