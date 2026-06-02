import type { Plugin } from 'vite';

/**
 * Vite plugin that replaces `env.<key>` accesses with boolean literals
 * in files that `import { env } from 'bongle'`.
 *
 * Pass the full env values object — every key will be replaced with its
 * boolean value, enabling dead code elimination by the bundler.
 *
 * Uses import-aware regex replacement: only replaces property accesses on
 * the `env` binding imported from 'bongle', not arbitrary `env.client`
 * strings in unrelated code. Skips replacements inside string literals.
 *
 * Per-environment scope: when `applyToEnvironmentName` is set, the plugin
 * registers `applyToEnvironment` so only that env's module graph receives
 * these substitutions. This lets multiple `envPlugin` instances coexist
 * with different value sets — e.g. client=true in the client env and
 * server=true in the gameServer env.
 */
export function envPlugin(values: Record<string, boolean>, applyToEnvironmentName?: string): Plugin {
    const keys = Object.keys(values);
    const keysPattern = keys.join('|');

    return {
        name: applyToEnvironmentName ? `bongle-env:${applyToEnvironmentName}` : 'bongle-env',
        applyToEnvironment: applyToEnvironmentName
            ? (environment) => environment.name === applyToEnvironmentName
            : undefined,

        transform(code, _id) {
            // Quick bail: if file doesn't reference any known env key, skip
            if (!keys.some((k) => code.includes(`env.${k}`))) {
                return null;
            }

            // Find the local name of `env` imported from 'bongle'
            const envLocalName = findEnvImportName(code);
            if (!envLocalName) {
                return null;
            }

            // Replace envLocalName.<key> with boolean literals.
            // Negative lookbehind ensures we don't match e.g. `process.env.client` or
            // `foo.env.client` (preceded by `.` or word char).
            // Negative lookahead skips assignment targets (env.x = ...) but allows
            // comparisons (env.x === ..., env.x == ...).
            const escaped = escapeRegex(envLocalName);
            const re = new RegExp(`(?<![.\\w])${escaped}\\.(${keysPattern})\\b(?!\\s*=[^=])`, 'g');

            const result = code.replace(re, (match, prop: string, offset: number) => {
                if (isInsideString(code, offset)) {
                    return match;
                }
                if (prop in values) return String(values[prop]);
                return match;
            });

            if (result === code) return null;
            return result;
        },
    };
}

/**
 * Finds the local binding name for `env` imported from 'bongle'.
 * Handles `import { env } from 'bongle'` and `import { env as foo } from 'bongle'`.
 */
function findEnvImportName(code: string): string | null {
    const importRegex = /import\s+\{([^}]*)\}\s+from\s+['"]bongle['"]/g;

    for (const match of code.matchAll(importRegex)) {
        const specifiers = match[1].split(',').map((s) => s.trim());
        for (const spec of specifiers) {
            const parts = spec.split(/\s+as\s+/);
            if (parts[0].trim() === 'env') {
                return (parts[1] || parts[0]).trim();
            }
        }
    }

    return null;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Simple heuristic to check if a given offset is inside a string literal.
 * Tracks unescaped single, double, and template quote state.
 */
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
