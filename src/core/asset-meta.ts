/** Cosmetic fields every declared asset kind carries the same way, so a picker for any kind filters by one rule: `assetMatches`. IDs stay the lookup key everywhere else. */
export type AssetMeta = {
    /** Display name for editor UIs. Falls back to the string id when omitted. */
    name?: string;
    /** Lowercase search words, e.g. `['wood', 'tree', 'oak']`. The id and name are already searched. */
    tags?: readonly string[];
};

/** The resolved shape a def carries: always set, so readers never fall back. */
export type ResolvedAssetMeta = {
    name: string;
    tags: readonly string[];
};

/** `name` defaulting to the id, `tags` lowercased, trimmed and deduplicated. */
export function resolveAssetMeta(id: string, options: AssetMeta | undefined): ResolvedAssetMeta {
    return { name: options?.name ?? id, tags: normalizeTags(options?.tags) };
}

export function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
    if (tags === undefined || tags.length === 0) return EMPTY_TAGS;
    const out: string[] = [];
    for (const raw of tags) {
        const tag = raw.trim().toLowerCase();
        if (tag.length > 0 && !out.includes(tag)) out.push(tag);
    }
    return out;
}

const EMPTY_TAGS: readonly string[] = Object.freeze([]);

/** The words a search can hit for an asset: id, name, tags. */
export function assetSearchTerms(asset: { id: string } & ResolvedAssetMeta): string[] {
    return [asset.id, asset.name, ...asset.tags];
}

/** Every whitespace-separated word of `query` must be found (case-insensitive substring) in at least one term, so `oak plant` finds oak leaves and not oak planks. */
export function assetMatches(asset: { id: string } & ResolvedAssetMeta, query: string): boolean {
    return termsMatch(assetSearchTerms(asset), query);
}

/** The same rule over any list of searchable strings (a picker's label, sublabel and keywords). */
export function termsMatch(terms: readonly string[], query: string): boolean {
    const words = query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0);
    if (words.length === 0) return true;
    const lower = terms.map((t) => t.toLowerCase());
    return words.every((word) => lower.some((term) => term.includes(word)));
}
