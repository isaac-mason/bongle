/**
 * tiny fuzzy matcher, subsequence scan with fzf-style bonuses. tuned for
 * short snake_case identifiers (block ids, command names) where the inputs
 * are O(hundreds) and queries are O(chars). returns the best score for a
 * candidate plus the matched character positions for optional highlight.
 *
 * not a port, just the same idea distilled down. greedy left-to-right
 * subsequence match (case-insensitive), scoring per matched char:
 *   +16  match at word boundary (start, or after `_-./ `)
 *   + 8  consecutive with previous match
 *   + 4  exact case match
 *   + 2  base
 *   - 1  per skipped (gap) char
 * empty query returns score 0 with no positions, every candidate trivially
 * matches; the caller decides whether to keep them.
 */

export type FuzzyResult = { score: number; positions: number[] };

const BOUNDARY = new Set(['_', '-', '.', '/', ' ']);

function isBoundary(target: string, i: number): boolean {
    if (i === 0) return true;
    return BOUNDARY.has(target[i - 1]!);
}

export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
    if (query.length === 0) return { score: 0, positions: [] };
    if (target.length === 0) return null;

    const q = query.toLowerCase();
    const t = target.toLowerCase();

    const positions: number[] = [];
    let score = 0;
    let qi = 0;
    let lastMatch = -2;

    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] !== q[qi]) {
            if (lastMatch >= 0) score -= 1;
            continue;
        }
        let bonus = 2;
        if (isBoundary(target, ti)) bonus += 16;
        if (ti === lastMatch + 1) bonus += 8;
        if (target[ti] === query[qi]) bonus += 4;
        score += bonus;
        positions.push(ti);
        lastMatch = ti;
        qi++;
    }

    if (qi < q.length) return null;
    return { score, positions };
}

export type FuzzyRanked<T> = { item: T; score: number; positions: number[] };

/** rank `items` by fuzzy match of `query` against `key(item)`. unmatched
 *  items are dropped. ties broken by shorter target first, then `key`
 *  alphabetical for deterministic ordering. */
export function fuzzyRank<T>(query: string, items: readonly T[], key: (item: T) => string): FuzzyRanked<T>[] {
    const out: FuzzyRanked<T>[] = [];
    for (const item of items) {
        const k = key(item);
        const m = fuzzyMatch(query, k);
        if (!m) continue;
        out.push({ item, score: m.score, positions: m.positions });
    }
    out.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ka = key(a.item);
        const kb = key(b.item);
        if (ka.length !== kb.length) return ka.length - kb.length;
        return ka.localeCompare(kb);
    });
    return out;
}
