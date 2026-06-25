/**
 * WorldEdit-style block masks. A Mask is a plain-object AST that answers
 * "does this voxel match?" — used to filter which positions a bulk op
 * affects.
 *
 * Subset of WorldEdit's mask grammar (see worldedit-docs masks.rst):
 *   - `stone`                 — block mask (states unspecified → fuzzy match)
 *   - `stone[axis=y]`         — block mask with required state
 *   - `stone,dirt`            — block OR list (one BlockMask matching any)
 *   - `stone dirt`            — intersection (space-separated)
 *   - `!stone`                — negation
 *   - `#existing`             — non-air
 *   - `%50`                   — random 50% of voxels
 *
 * Unlike patterns, unspecified states in a block mask fuzzy-match any value
 * (matching WE's BlockMask semantics). Unlike pattern weights, mask `%N` is
 * literally N% (not relative).
 *
 * Open union — add `solid`, `fullCube`, `surface`, `category`, `offset`,
 * `adjacent`, `state`, `expression`, `biome`, `clipboard`, `region` as
 * needed by extending the type + matching in `parseMask` / `testMask`.
 */

import { fuzzyRank } from '../../core/utils/fuzzy';
import { parseKey } from '../../core/voxels/block-registry';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
import { splitTopLevel } from './pattern';

export type BlockMatch = {
    blockId: string;
    /** unspecified props fuzzy-match any value at the voxel. */
    props?: Record<string, string>;
};

export type Mask =
    | { kind: 'blocks'; blocks: BlockMatch[] }
    | { kind: 'not'; mask: Mask }
    | { kind: 'and'; masks: Mask[] }
    | { kind: 'existing' }
    | { kind: 'noise'; percent: number };

/** test whether a mask matches at a world position. */
export function testMask(m: Mask, voxels: Voxels, x: number, y: number, z: number, rng: () => number = Math.random): boolean {
    switch (m.kind) {
        case 'blocks': {
            const key = getBlock(voxels, x, y, z);
            const parsed = parseKey(key);
            if (!parsed) return false;
            for (const match of m.blocks) {
                if (match.blockId !== parsed.blockId) continue;
                if (!match.props) return true;
                let ok = true;
                for (const k in match.props) {
                    if (parsed.props[k] !== match.props[k]) {
                        ok = false;
                        break;
                    }
                }
                if (ok) return true;
            }
            return false;
        }
        case 'not':
            return !testMask(m.mask, voxels, x, y, z, rng);
        case 'and':
            for (const sub of m.masks) {
                if (!testMask(sub, voxels, x, y, z, rng)) return false;
            }
            return true;
        case 'existing':
            return getBlock(voxels, x, y, z) !== BLOCK_AIR;
        case 'noise':
            return rng() * 100 < m.percent;
    }
}

/** parse a mask string into the AST. throws on syntax error. */
export function parseMask(input: string): Mask {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('mask: empty input');

    const components = splitTopLevel(trimmed, ' ')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    if (components.length === 0) throw new Error('mask: empty input');
    if (components.length === 1) return parseComponent(components[0]!);
    return { kind: 'and', masks: components.map(parseComponent) };
}

function parseComponent(token: string): Mask {
    if (token.startsWith('!')) {
        return { kind: 'not', mask: parseComponent(token.slice(1)) };
    }
    if (token === '#existing') return { kind: 'existing' };
    if (token.startsWith('%')) {
        const percent = Number.parseFloat(token.slice(1));
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
            throw new Error(`mask: bad noise percent: ${token}`);
        }
        return { kind: 'noise', percent };
    }
    // block OR list — at this point any leftover `,` is between block keys
    const blocks = splitTopLevel(token, ',').map((part) => {
        const parsed = parseKey(part.trim());
        if (!parsed) throw new Error(`mask: bad block: ${part}`);
        const match: BlockMatch = { blockId: parsed.blockId };
        if (Object.keys(parsed.props).length > 0) match.props = parsed.props;
        return match;
    });
    return { kind: 'blocks', blocks };
}

// ── autocomplete ───────────────────────────────────────────────────
// see pattern.ts:suggestPattern — same shape, different token rules.
// mask boundaries are space (AND) and comma (OR-list within a component);
// the active token is the OR-list item under the caret. unary `!` is part
// of the OR-list item; `#existing` is a single keyword. when the item is
// empty we also offer the structural prefixes (`!`, `#`).

export type MaskSuggestion = { text: string; label?: string; detail?: string };
export type MaskSuggestResult = {
    replaceStart: number;
    replaceEnd: number;
    suggestions: MaskSuggestion[];
};

export function suggestMask(
    text: string,
    cursor: number,
    blockIds: ReadonlyArray<{ id: string; name?: string }>,
): MaskSuggestResult {
    // walk back over chars that aren't a space or `,` at depth 0 — that
    // identifies the innermost OR-list item being edited.
    let depth = 0;
    let tokenStart = 0;
    for (let i = 0; i < cursor; i++) {
        const ch = text[i]!;
        if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') depth--;
        else if (depth === 0 && (ch === ' ' || ch === ',')) tokenStart = i + 1;
    }
    // is this token the start of a component (preceded by space or BOL)?
    // OR-list items (preceded by `,`) only accept block ids — no `!`/`#`/`%`.
    const prevCh = tokenStart > 0 ? text[tokenStart - 1] : '';
    const isComponentStart = tokenStart === 0 || prevCh === ' ';

    // strip a single leading `!` for filtering. on accept we keep it.
    const tokenText = text.slice(tokenStart, cursor);
    const negated = tokenText.startsWith('!');
    const bodyStart = tokenStart + (negated ? 1 : 0);
    const body = text.slice(bodyStart, cursor).toLowerCase();

    const out: MaskSuggestion[] = [];
    // structural keywords — only at component start (not inside an OR list).
    if (isComponentStart) {
        if ('#existing'.startsWith(body)) out.push({ text: '#existing', detail: 'non-air blocks' });
        // `%` noise prefix has no real completion (just a number), but show
        // it as a hint when the user hasn't typed anything yet.
        if (body.length === 0 && !negated) out.push({ text: '%50', label: '%<n>', detail: 'random N% of voxels' });
    }
    // empty body → registry order; non-empty → fuzzy-rank.
    if (body.length === 0) {
        for (const b of blockIds) {
            out.push({ text: b.id, label: b.id, detail: b.name && b.name !== b.id ? b.name : undefined });
            if (out.length >= 64) break;
        }
    } else {
        const ranked = fuzzyRank(body, blockIds, (b) => b.id);
        for (const { item: b } of ranked) {
            out.push({ text: b.id, label: b.id, detail: b.name && b.name !== b.id ? b.name : undefined });
            if (out.length >= 64) break;
        }
    }
    return { replaceStart: bodyStart, replaceEnd: cursor, suggestions: out };
}
