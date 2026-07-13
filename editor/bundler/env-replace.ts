// editor/bundler/env-replace.ts — the pure `env.<key>` → literal replacement,
// vite-free so it runs BOTH as a vite plugin (env-plugin.ts) and inside the
// editor's in-browser transform (transform.ts / @rolldown/browser), per env.
//
// Import-aware: only rewrites property accesses on the `env` binding imported
// from 'bongle', and skips matches inside string literals + assignment targets.

export type EnvValues = Record<string, boolean>;

/** Replace `env.<key>` reads with boolean literals. Returns the code unchanged
 *  if there's nothing to do (no `env` import, or no matching accesses). */
export function replaceEnv(code: string, values: EnvValues): string {
    const keys = Object.keys(values);
    if (!keys.some((k) => code.includes(`env.${k}`))) return code;

    const envLocalName = findEnvImportName(code);
    if (!envLocalName) return code;

    // negative lookbehind: don't match `process.env.client` / `foo.env.client`.
    // negative lookahead: skip assignment targets (`env.x = …`) but allow
    // comparisons (`env.x === …`).
    const re = new RegExp(`(?<![.\\w])${escapeRegex(envLocalName)}\\.(${keys.join('|')})\\b(?!\\s*=[^=])`, 'g');
    return code.replace(re, (match, prop: string, offset: number) => {
        if (isInsideString(code, offset)) return match;
        return prop in values ? String(values[prop]) : match;
    });
}

/** Local binding name for `env` imported from 'bongle' or 'bongle/env'. Handles
 *  `import { env }`, `import { env as foo }`, and the whitespace-minimal bundled
 *  form the prebundle emits (`import{env as env$2}from"bongle/env"`). The
 *  'bongle/env' seam is how env survives the prebundle recognizably (the engine
 *  chunks import env from there; see vite.lib.config externalizeEnvSeam). */
function findEnvImportName(code: string): string | null {
    const importRegex = /import\s*\{([^}]*)\}\s*from\s*['"]bongle(?:\/env)?['"]/g;
    for (const match of code.matchAll(importRegex)) {
        for (const spec of match[1].split(',').map((s) => s.trim())) {
            const parts = spec.split(/\s+as\s+/);
            if (parts[0].trim() === 'env') return (parts[1] || parts[0]).trim();
        }
    }
    return null;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Heuristic: is `offset` inside a string/template literal? Tracks unescaped
 *  quote state up to the offset. */
function isInsideString(code: string, offset: number): boolean {
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    for (let i = 0; i < offset; i++) {
        const ch = code[i];
        if (i > 0 && code[i - 1] === '\\') continue;
        if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
        if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
        if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate;
    }
    return inSingle || inDouble || inTemplate;
}
