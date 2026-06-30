/**
 * server-side profanity matching. used by the per-room chat server to
 * shadow-filter plain messages: a matched line is delivered back to the
 * sender alone (so their UI shows it as normal) but never fanned to the
 * rest of the room, no error, no masking, no signal to work around.
 *
 * matching is whole-token with leetspeak normalization: each whitespace
 * token is normalized (leet substitutions + non-alpha stripped) and tested
 * for membership in the word set. so `ass` / `a$$` / `a.s.s` match but
 * `assassin` and `class` do not (substrings are never matched).
 *
 * the word set lives in the generated ./profanity.data, see
 * scripts/gen-profanity.ts. `normalizeToken` is the single source of truth
 * for normalization, shared by the generator (build time) and the matcher
 * (runtime) so the two can never drift.
 */

import { PROFANITY_WORDS } from './profanity.data';

/** digit leetspeak, always substituted to its letter. */
const LEET_DIGITS: Record<string, string> = {
    '0': 'o',
    '1': 'i',
    '3': 'e',
    '4': 'a',
    '5': 's',
    '7': 't',
    '8': 'b',
};

/** punctuation leetspeak, ambiguous, since these chars are also ordinary
 *  punctuation. matched two ways (see `containsProfanity`): mapped to their
 *  letter (so `sh!t` → `shit`) and dropped (so a trailing `fuck!` → `fuck`
 *  rather than `fucki`, which would bypass the filter). */
const LEET_PUNCT: Record<string, string> = {
    '@': 'a',
    $: 's',
    '!': 'i',
    '|': 'l',
    '+': 't',
};

/** shortest token we bother matching, guards against `as`, `ad`, etc.
 *  must match the floor used when generating ./profanity.data. */
export const MIN_PROFANITY_LEN = 3;

/**
 * fold a raw token to a canonical alpha form: lowercase, substitute digit
 * leet, handle punctuation leet per `mapPunct`, drop every other non `a-z`
 * character. with `mapPunct` true `"A$$.hole"` → `"asshole"`; with it false
 * the same input → `"ashole"` (the `$` are dropped, not mapped).
 */
function fold(raw: string, mapPunct: boolean): string {
    let out = '';
    for (const ch of raw.toLowerCase()) {
        const digit = LEET_DIGITS[ch];
        if (digit !== undefined) {
            out += digit;
            continue;
        }
        const punct = LEET_PUNCT[ch];
        if (punct !== undefined) {
            if (mapPunct) out += punct;
            continue;
        }
        if (ch >= 'a' && ch <= 'z') out += ch;
    }
    return out;
}

/**
 * canonical normalization (punctuation leet mapped to letters). used at
 * build time to canonicalize list entries, since list entries are plain
 * a-z, this is effectively identity for them, and exported for tests.
 */
export function normalizeToken(raw: string): string {
    return fold(raw, true);
}

/**
 * true when any whitespace-delimited token of `line`, once normalized, is a
 * known profanity. whole-token only, never matches substrings. each token
 * is tested both with punctuation-leet mapped (`a$$` → `ass`) and stripped
 * (`fuck!` → `fuck`), so neither evasion nor trailing punctuation slips by.
 */
export function containsProfanity(line: string): boolean {
    for (const token of line.split(/\s+/)) {
        if (!token) continue;
        const mapped = fold(token, true);
        if (mapped.length >= MIN_PROFANITY_LEN && PROFANITY_WORDS.has(mapped)) return true;
        const stripped = fold(token, false);
        if (stripped !== mapped && stripped.length >= MIN_PROFANITY_LEN && PROFANITY_WORDS.has(stripped)) {
            return true;
        }
    }
    return false;
}
