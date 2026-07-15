// editor/bundler/resolve.ts — module resolution over the editor's vfs.
//
// A hand-rolled SUBSET of Node ESM resolution, shared by both the edit-time
// module runner (dev-server.ts) and the prod build (build.ts). It works against
// the project vfs instead of a real filesystem; each caller keeps only its own
// transport quirks (dev's rolldown code-split root-relative ids, build's virtual
// entry + node: externals) and delegates the Node-shaped work to here.
//
// DOCUMENTED SUBSET.
//   In scope:
//     - relative ('./', '../') specifiers, resolved against the importer's dir;
//     - extension probing (.js/.mjs/.ts/.tsx) + directory `index` files;
//     - one FLAT node_modules at the vfs root (packages are seeded there);
//     - package.json `exports`: subpath maps, `./*` wildcard patterns, and
//       condition selection (import/module/browser/default), plus the shorthand
//       string / bare-conditions forms;
//     - the legacy `main`/`module` entry when there's no `exports`.
//   Out of scope (the vfs is a controlled, flat, ESM-only tree we seed ourselves
//   — add one only when a seeded package actually needs it):
//     - parent-directory node_modules walking (there is only the root one);
//     - the `imports` field / `#specifier` internal imports;
//     - CJS/`require` resolution and `type: "commonjs"`;
//     - the `browser` object-remap field and platform conditions (node/deno);
//     - symlink realpath.
//
// Directories report `exists() === true` on our Filesystem, so file probing goes
// through `stat().kind` — never `exists` — to avoid resolving a specifier to a
// directory that merely shares its name.

/** the narrow filesystem surface resolution needs (a subset of `Filesystem`). */
export type ResolveFs = {
    /** immediate children of a dir as name→kind (see Filesystem.readDir) — the
     *  fs caches this per directory, so a whole import's candidate probing is one
     *  listing + in-memory lookups, not a `stat` per candidate. */
    readDir(dir: string): Promise<Map<string, 'file' | 'dir'>>;
    readText(path: string): Promise<string>;
};

/** the package.json fields this resolver reads. */
export type PackageJson = { main?: string; module?: string; exports?: unknown };

/** condition names tried, in order, when selecting an `exports` target. Our
 *  seeds only use `import`/`default` (+ `types`, which the runtime resolver
 *  ignores); `module`/`browser` are forward-safe and cost nothing when absent. */
export const DEFAULT_CONDITIONS = ['import', 'module', 'browser', 'default'];

export type ResolveOptions = {
    /** override the condition priority list (default: DEFAULT_CONDITIONS). */
    conditions?: string[];
    /** shared package.json parse cache (pkg name → parsed | null miss). Pass one
     *  to amortize reads across a whole graph; omit for a one-off resolve. */
    pkgCache?: Map<string, PackageJson | null>;
};

// ── path utils (posix, vfs-relative — no leading slash) ─────────────────────

/** join `rel` onto directory `dir`, collapsing `.`/`..`. */
export function posixJoin(dir: string, rel: string): string {
    const out: string[] = [];
    for (const part of `${dir}/${rel}`.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
    }
    return out.join('/');
}

/** the directory of a module id ('a/b/c.ts' → 'a/b', 'x.ts' → ''). */
export function dirOf(id: string): string {
    const i = id.lastIndexOf('/');
    return i === -1 ? '' : id.slice(0, i);
}

const hasExtension = (id: string): boolean => /\.[a-z0-9]+$/i.test(id.slice(id.lastIndexOf('/') + 1));

// ── RESOLVE_FILE: extension + directory-index probe ─────────────────────────

const FILE_EXTENSIONS = ['.js', '.mjs', '.ts', '.tsx'];

/** resolve a concrete vfs target to an existing file: the path itself (if it
 *  already names a file), then `<target><ext>`, then `<target>/index<ext>`. One
 *  cached directory listing + in-memory checks, not a probe per candidate. null
 *  when nothing matches. */
export async function resolveFile(fs: ResolveFs, target: string): Promise<string | null> {
    const slash = target.lastIndexOf('/');
    const dir = slash === -1 ? '' : target.slice(0, slash);
    const base = slash === -1 ? target : target.slice(slash + 1);
    const entries = await fs.readDir(dir);

    if (hasExtension(base) && entries.get(base) === 'file') return target;
    for (const ext of FILE_EXTENSIONS) {
        if (entries.get(`${base}${ext}`) === 'file') return `${target}${ext}`;
    }
    // directory index — only worth a second listing when `base` is a real dir.
    if (entries.get(base) === 'dir') {
        const sub = await fs.readDir(target);
        for (const ext of FILE_EXTENSIONS) {
            if (sub.get(`index${ext}`) === 'file') return `${target}/index${ext}`;
        }
    }
    return null;
}

// ── package.json `exports` ──────────────────────────────────────────────────

type ExportsValue = string | null | ExportsValue[] | { [key: string]: ExportsValue };

/** PACKAGE_TARGET_RESOLVE: reduce a target to a package-relative path, selecting
 *  a condition branch and substituting the `*` capture (`star`) when present. */
function resolveTarget(target: ExportsValue, star: string, conditions: string[]): string | null {
    if (typeof target === 'string') {
        if (!target.startsWith('./')) return null; // targets must stay inside the package
        return star ? target.replace(/\*/g, star) : target;
    }
    if (Array.isArray(target)) {
        for (const entry of target) {
            const hit = resolveTarget(entry, star, conditions);
            if (hit) return hit;
        }
        return null;
    }
    if (target && typeof target === 'object') {
        for (const cond of conditions) {
            if (cond in target) {
                const hit = resolveTarget(target[cond], star, conditions);
                if (hit !== null) return hit;
            }
        }
    }
    return null; // a `null` target explicitly blocks the subpath
}

/** PACKAGE_EXPORTS_RESOLVE: map `subpath` ('.' or './a/b') through an `exports`
 *  field to a package-relative path, or null if unexported. */
function resolveExports(exports: ExportsValue, subpath: string, conditions: string[]): string | null {
    const keys = exports && typeof exports === 'object' && !Array.isArray(exports) ? Object.keys(exports) : [];
    // a subpath map has '.'-prefixed keys; anything else (string, array, bare
    // conditions object) is itself the '.' target.
    const isSubpathMap = keys.some((k) => k.startsWith('.'));
    if (!isSubpathMap) {
        return subpath === '.' ? resolveTarget(exports, '', conditions) : null;
    }
    const map = exports as { [key: string]: ExportsValue };
    if (subpath in map) return resolveTarget(map[subpath], '', conditions);
    // longest-prefix `./prefix*suffix` pattern match.
    let match: { target: ExportsValue; star: string } | null = null;
    let bestPrefix = -1;
    for (const key of keys) {
        const star = key.indexOf('*');
        if (star === -1) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (!subpath.startsWith(prefix) || (suffix && !subpath.endsWith(suffix))) continue;
        if (subpath.length < prefix.length + suffix.length) continue;
        if (prefix.length > bestPrefix) {
            bestPrefix = prefix.length;
            match = { target: map[key], star: subpath.slice(prefix.length, subpath.length - suffix.length) };
        }
    }
    return match ? resolveTarget(match.target, match.star, conditions) : null;
}

// ── PACKAGE_RESOLVE ─────────────────────────────────────────────────────────

/** resolve a bare specifier ('pkg', 'pkg/sub', '@scope/pkg/sub') to a vfs module
 *  id via its seeded node_modules package.json, or null if no such package /
 *  subpath. */
export async function resolvePackage(fs: ResolveFs, spec: string, opts: ResolveOptions = {}): Promise<string | null> {
    const conditions = opts.conditions ?? DEFAULT_CONDITIONS;
    const scoped = spec.startsWith('@');
    const parts = spec.split('/');
    const pkg = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
    const subParts = scoped ? parts.slice(2) : parts.slice(1);
    const subpath = subParts.length ? `./${subParts.join('/')}` : '.';
    const pkgDir = `node_modules/${pkg}`;

    let json = opts.pkgCache?.get(pkg);
    if (json === undefined) {
        try {
            json = JSON.parse(await fs.readText(`${pkgDir}/package.json`)) as PackageJson;
        } catch {
            json = null;
        }
        opts.pkgCache?.set(pkg, json);
    }
    if (!json) return null;

    let target: string | null;
    if (json.exports !== undefined) {
        target = resolveExports(json.exports as ExportsValue, subpath, conditions);
    } else if (subpath === '.') {
        target = json.module ?? json.main ?? './index.js';
    } else {
        target = subpath; // no exports → the subpath is a literal file path
    }
    if (!target) return null;
    return resolveFile(fs, posixJoin(pkgDir, target));
}

// ── entry point ─────────────────────────────────────────────────────────────

/** resolve a relative ('./x') or bare ('pkg/sub') specifier to a vfs module id,
 *  or null when nothing matches. `/`-absolute and other transport-specific ids
 *  are the caller's concern (see dev-server.ts / build.ts) — call `resolveFile`
 *  directly for those. */
export async function resolveModule(
    fs: ResolveFs,
    spec: string,
    importer: string | undefined,
    opts: ResolveOptions = {},
): Promise<string | null> {
    if (spec.startsWith('.')) return resolveFile(fs, posixJoin(dirOf(importer ?? ''), spec));
    return resolvePackage(fs, spec, opts);
}
