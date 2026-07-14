// editor/devtools.ts — expose a per-realm `bongle` global for DevTools poking.
// Open the realm's console context (the editor doc, a client <iframe>, or the
// server worker in the console context dropdown) and type `bongle`. This is a
// debugging / automation convenience — "paste this into your console" — not a
// stable API; each realm passes whatever handles are useful there.

export function exposeDevtools(realm: 'editor' | 'client' | 'server', api: Record<string, unknown>): void {
    const bongle = {
        realm,
        help: () => console.log(`bongle [${realm}]:`, Object.keys(api).sort().join(', ')),
        ...api,
    };
    (globalThis as unknown as { bongle: unknown }).bongle = bongle;
    console.log(`%cbongle devtools [${realm}] ready — type \`bongle\` (or bongle.help())`, 'color:#22c55e;font-weight:bold');
}
