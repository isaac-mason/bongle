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
    // ALL local bindings for `env` — the prebundle emits deduped aliases in one
    // chunk (`import { env, env as env$1 } from "bongle/env"`), and both are used;
    // replacing only the first leaves `env$1.editor` reading the false default.
    const names = findEnvImportNames(code);
    if (names.length === 0) return code;

    const nameAlt = names.map(escapeRegex).join('|');
    // negative lookbehind: don't match `process.env.client` / `foo.env.client`.
    // negative lookahead: skip assignment targets (`env.x = …`) but allow
    // comparisons (`env.x === …`).
    const re = new RegExp(`(?<![.\\w])(?:${nameAlt})\\.(${keys.join('|')})\\b(?!\\s*=[^=])`, 'g');
    return code.replace(re, (match, prop: string, offset: number) => {
        if (isInsideString(code, offset)) return match;
        return prop in values ? String(values[prop]) : match;
    });
}

/** Every local binding name for `env` imported from 'bongle' or 'bongle/env'.
 *  Handles `import { env }`, `import { env as foo }`, multiple bindings in one
 *  clause (`{ env, env as env$1 }`), and the whitespace-minimal bundled form
 *  (`import{env as env$2}from"bongle/env"`). The 'bongle/env' seam is how env
 *  survives the prebundle recognizably (see vite.lib.config externalizeEnvSeam). */
function findEnvImportNames(code: string): string[] {
    const names = new Set<string>();
    const importRegex = /import\s*\{([^}]*)\}\s*from\s*['"]bongle(?:\/env)?['"]/g;
    for (const match of code.matchAll(importRegex)) {
        for (const spec of match[1].split(',').map((s) => s.trim())) {
            if (!spec) continue;
            const parts = spec.split(/\s+as\s+/);
            if (parts[0].trim() === 'env') names.add((parts[1] || parts[0]).trim());
        }
    }
    return [...names];
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
