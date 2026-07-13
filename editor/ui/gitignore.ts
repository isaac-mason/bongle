// editor/ui/gitignore.ts — a small, dependency-free .gitignore matcher. Covers
// the conventions the tree needs to gray out non-persisted entries: comments +
// blank lines, `!` negation, `/`-anchoring (leading or interior slash anchors to
// root; otherwise a pattern matches at any depth), trailing-`/` dir-only
// patterns, `*` / `?` / `**` globs and `[..]` classes, evaluated last-match-wins.
//
// `ignores` decides a single entity. Ancestor-directory exclusion (a file under
// an ignored dir stays ignored, and can't be re-included) is applied by the
// caller's top-down tree walk, not here.

type Rule = { negate: boolean; dirOnly: boolean; re: RegExp };

export type Gitignore = { ignores: (path: string, isDir: boolean) => boolean };

function toRegExp(glob: string): RegExp {
    let anchored = false;
    if (glob.startsWith('/')) {
        anchored = true;
        glob = glob.slice(1);
    } else if (glob.includes('/')) {
        anchored = true;
    }
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                const prevSlash = i === 0 || glob[i - 1] === '/';
                const nextSlash = glob[i + 2] === '/';
                if (prevSlash && nextSlash) {
                    re += '(?:.*/)?'; // `**/` — zero or more directories
                    i += 2;
                } else {
                    re += '.*'; // `**` elsewhere — anything, crossing slashes
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '/') {
            re += '/';
        } else if (c === '[') {
            let j = i + 1;
            let cls = '[';
            if (glob[j] === '!') {
                cls += '^';
                j++;
            }
            while (j < glob.length && glob[j] !== ']') cls += glob[j++];
            cls += ']';
            re += cls;
            i = j;
        } else {
            re += c.replace(/[.+^${}()|\\]/g, '\\$&');
        }
    }
    return new RegExp(`${anchored ? '^' : '(?:^|.*/)'}${re}$`);
}

export function parseGitignore(content: string): Gitignore {
    const rules: Rule[] = [];
    for (let line of content.split(/\r?\n/)) {
        line = line.replace(/(?<!\\)\s+$/, ''); // trailing spaces (unless escaped)
        if (!line || line.startsWith('#')) continue;
        let negate = false;
        if (line.startsWith('!')) {
            negate = true;
            line = line.slice(1);
        }
        let dirOnly = false;
        if (line.endsWith('/')) {
            dirOnly = true;
            line = line.slice(0, -1);
        }
        rules.push({ negate, dirOnly, re: toRegExp(line) });
    }
    return {
        ignores(path, isDir) {
            let res = false;
            for (const r of rules) {
                if ((!r.dirOnly || isDir) && r.re.test(path)) res = !r.negate;
            }
            return res;
        },
    };
}
