// ── asset meta: the fields every declared asset shares for people, not code ──
//
// `name` is what the editor shows, `tags` are what it searches. Both are
// authored on the declaration next to the fields that matter to the engine,
// and every asset kind carries them the same way (block, sprite, model,
// sound, particle, scene, prefab), so a picker for any kind filters by one
// rule: `assetMatches`. IDs stay the lookup key everywhere else.

/** the authoring shape: both optional, both cosmetic. */
export type AssetMeta = {
    /** human-readable display name for editor UIs (inventory, pickers,
     *  inspectors). falls back to the string id when omitted. */
    name?: string;
    /** search words for editor UIs, lowercase, e.g. `['wood', 'tree', 'oak']`.
     *  A search hits an asset when every word of the query is found in its
     *  id, its name or one of its tags. Keep them to what someone would type
     *  looking for this thing; the id and name are already searched. */
    tags?: readonly string[];
};

/** the resolved shape a def carries: always set, so readers never fall back. */
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

/** the words a search can hit for an asset: id, name, tags. */
export function assetSearchTerms(asset: { id: string } & ResolvedAssetMeta): string[] {
    return [asset.id, asset.name, ...asset.tags];
}

/**
 * Does `query` hit this asset? Every whitespace-separated word of the query
 * must be found (case-insensitive substring) in at least one of the terms,
 * so `oak plant` finds oak leaves and not oak planks. An empty query hits
 * everything.
 */
export function assetMatches(asset: { id: string } & ResolvedAssetMeta, query: string): boolean {
    return termsMatch(assetSearchTerms(asset), query);
}

/** the same rule over any list of searchable strings (a picker's label,
 *  sublabel and keywords). */
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
