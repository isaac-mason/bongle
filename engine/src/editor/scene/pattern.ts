/**
 * WorldEdit-style block patterns. A Pattern is a plain-object AST that
 * answers "what block should I place here?" — it is sampled per voxel by
 * bulk ops like fill / replace.
 *
 * The grammar is a subset of WorldEdit's (see worldedit-docs patterns.rst):
 *   - `stone`                 — single block (with optional `[k=v,...]` state)
 *   - `stone,dirt`            — equal-weight random list
 *   - `10%stone,90%dirt`      — weighted random (weights are relative, not %)
 *   - `$active`               — resolves at sample-time to whatever block is
 *                               in the active hotbar slot. callers pass it via
 *                               `samplePattern(..., active)`; brushes default
 *                               their pattern to this token.
 *
 * Decimals on weights are allowed. Brackets are protected when splitting on
 * `,` so `stone_stairs[half=top],dirt` parses correctly.
 *
 * The union is intentionally open — add new kinds (randomState, category,
 * clipboard, typeApply, stateApply) by extending the type and matching them
 * in `parsePattern` / `samplePattern`.
 */
import { parseKey } from '../../core/voxels/block-registry';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR } from '../../core/voxels/voxels';
import { fuzzyRank } from '../../core/utils/fuzzy';

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
 * sample a pattern at a world position. returns a block key string e.g.
 * `oak_log[axis=y]`.
 *
 * `voxels` + `x,y,z` are mandatory so kinds that read world state at the
 * target position (future: `clipboard`, `typeApply`, `stateApply`,
 * `repeatingExtent`, `waterloggedRemover`) can do so without a signature
 * change. Current `block` / `random` kinds ignore them.
 *
 * `active` is the block key the `$active` token resolves to (the active
 * hotbar slot's block when called from the editor; falls back to air when
 * the slot is empty or non-block).
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

// ── autocomplete ───────────────────────────────────────────────────
// thin completion helper used by the editor's <ExprInput> wrapper. given
// the input text + caret position, returns the substring range to replace
// and a ranked candidate list. kept inside this module so the grammar and
// its suggestions stay in lockstep — if a new pattern kind is added above,
// add a token here too.

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
    // walk back from cursor over non-comma at depth 0 — that's the token
    // currently being edited.
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
    // strip leading whitespace inside the token (after a `,` users typically
    // hit space) so the body offset is right.
    const wsLen = (tokenText.match(/^\s*/)?.[0].length) ?? 0;
    const prefixLen = weightMatch ? weightMatch[0].length : wsLen;
    const bodyStart = tokenStart + prefixLen;
    const body = text.slice(bodyStart, cursor).toLowerCase();

    const out: PatternSuggestion[] = [];
    // `$active` always offered when body is empty or starts with `$`.
    if (body.length === 0 || '$active'.startsWith(body)) {
        out.push({ text: '$active', detail: 'active hotbar slot' });
    }
    // empty body → preserve registry order (alphabetical block ids).
    // non-empty → fuzzy-rank so 'plk' surfaces oak_planks, etc.
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
