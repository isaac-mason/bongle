import { fuzzyRank } from '../../core/utils/fuzzy';
import { parseKey } from '../../core/voxels/block-registry';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR } from '../../core/voxels/voxels';

export type BlockSpec = {
    blockId: string;
    /** unspecified props resolve to the block's defaults when placed. */
    props?: Record<string, string>;
};

export type Pattern =
    | { kind: 'block'; block: BlockSpec }
    | { kind: 'active' }
    | { kind: 'random'; choices: Array<{ pattern: Pattern; weight: number }> };

/**
 * Samples a pattern at a world position into a block key, e.g. `oak_log[axis=y]`.
 * `voxels`/`x,y,z` are unused by `block`/`random` but let future kinds read world state.
 */
export function samplePattern(
    p: Pattern,
    voxels: Voxels,
    x: number,
    y: number,
    z: number,
    active: string,
    rng: () => number = Math.random,
): string {
    switch (p.kind) {
        case 'block':
            return blockKey(p.block);
        case 'active':
            return active || BLOCK_AIR;
        case 'random': {
            const total = p.choices.reduce((s, c) => s + c.weight, 0);
            let r = rng() * total;
            for (const c of p.choices) {
                r -= c.weight;
                if (r <= 0) return samplePattern(c.pattern, voxels, x, y, z, active, rng);
            }
            return samplePattern(p.choices[p.choices.length - 1]!.pattern, voxels, x, y, z, active, rng);
        }
    }
}

function blockKey(b: BlockSpec): string {
    if (!b.props || Object.keys(b.props).length === 0) return b.blockId;
    const parts = Object.entries(b.props).map(([k, v]) => `${k}=${v}`);
    return `${b.blockId}[${parts.join(',')}]`;
}

/** parse a pattern string into the AST. throws on syntax error. */
export function parsePattern(input: string): Pattern {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('pattern: empty input');

    const tokens = splitTopLevel(trimmed, ',');
    if (tokens.length === 1) return parseSingle(tokens[0]!);

    const weightRe = /^([0-9]+(?:\.[0-9]*)?)%(.+)$/;
    const choices = tokens.map((token) => {
        const m = weightRe.exec(token);
        if (m) {
            const weight = Number.parseFloat(m[1]!);
            if (!(weight > 0)) throw new Error(`pattern: weight must be > 0: ${token}`);
            return { pattern: parseSingle(m[2]!), weight };
        }
        return { pattern: parseSingle(token), weight: 1 };
    });
    return { kind: 'random', choices };
}

function parseSingle(token: string): Pattern {
    const t = token.trim();
    if (!t) throw new Error('pattern: empty token');
    if (t === '$active') return { kind: 'active' };
    const parsed = parseKey(t);
    if (!parsed) throw new Error(`pattern: bad block: ${t}`);
    const block: BlockSpec = { blockId: parsed.blockId };
    if (Object.keys(parsed.props).length > 0) block.props = parsed.props;
    return { kind: 'block', block };
}

// When a new pattern kind is added above, add a completion token below too.

export type PatternSuggestion = { text: string; label?: string; detail?: string };
export type PatternSuggestResult = {
    replaceStart: number;
    replaceEnd: number;
    suggestions: PatternSuggestion[];
};

const WEIGHT_PREFIX_RE = /^[0-9]+(?:\.[0-9]*)?%/;

export function suggestPattern(
    text: string,
    cursor: number,
    blockIds: ReadonlyArray<{ id: string; name?: string }>,
): PatternSuggestResult {
    let depth = 0;
    let tokenStart = 0;
    for (let i = 0; i < cursor; i++) {
        const ch = text[i]!;
        if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') depth--;
        else if (depth === 0 && ch === ',') tokenStart = i + 1;
    }
    let tokenEnd = text.length;
    let d = depth;
    for (let i = cursor; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === '[' || ch === '{') d++;
        else if (ch === ']' || ch === '}') d--;
        else if (d === 0 && ch === ',') {
            tokenEnd = i;
            break;
        }
    }

    const tokenText = text.slice(tokenStart, tokenEnd);
    const weightMatch = WEIGHT_PREFIX_RE.exec(tokenText);
    const wsLen = tokenText.match(/^\s*/)?.[0].length ?? 0;
    const prefixLen = weightMatch ? weightMatch[0].length : wsLen;
    const bodyStart = tokenStart + prefixLen;
    const body = text.slice(bodyStart, cursor).toLowerCase();

    const out: PatternSuggestion[] = [];
    if (body.length === 0 || '$active'.startsWith(body)) {
        out.push({ text: '$active', detail: 'active hotbar slot' });
    }
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

/** split on `sep` at depth 0, respecting `[...]` and `{...}` nesting. */
export function splitTopLevel(input: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') depth--;
        else if (depth === 0 && ch === sep) {
            out.push(input.slice(start, i));
            start = i + 1;
        }
    }
    out.push(input.slice(start));
    return out;
}
