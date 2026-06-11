// Regenerates src/core/profanity.data.ts from a raw profanity word-list CSV.
//
// usage: npx tsx scripts/gen-profanity.ts [path-to-profanity.csv]
//   default path: ~/Downloads/profanity.csv
//
// The source CSV is messy: ~41k rows of column-1 terms (many leetspeak
// variants), plus quote-wrapped multi-line commentary blocks. We parse it
// quote-aware (so commentary fields stay a single record and get dropped by
// the length filter), take column 1, canonicalize each entry with the SAME
// normalizeToken the runtime matcher uses, keep tokens of length
// [MIN_PROFANITY_LEN, MAX_LEN], subtract an allowlist of innocent words the
// raw list over-includes, and emit a sorted, deduped Set literal.
//
// The raw CSV is intentionally NOT committed — only the generated artifact is.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_PROFANITY_LEN, normalizeToken } from '../src/core/profanity';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../src/core/profanity.data.ts');
const SRC = process.argv[2] ?? join(homedir(), 'Downloads', 'profanity.csv');

/** longest token worth keeping — anything longer is merged junk from a
 *  broken/commentary row, not a word anyone types as a single token. */
const MAX_LEN = 15;

/**
 * "Moderate" allowlist: real English words the raw list sweeps in that we do
 * NOT want to block. Kept blocked (i.e. NOT here): hard slurs, strong
 * profanity, and overt sexual acts. Allowlisted here: innocent words and
 * innocent homographs (niggardly, clansman, pollock, seaman, cockfight),
 * mild words, clinical anatomy, drug names, and identity terms (gay, lesbian,
 * jew, ...). Edit and rerun the generator to retune. Normalized on load so
 * entries match the same canonical form as the word set.
 */
const ALLOWLIST = [
    // innocent words / homographs / names the list wrongly includes
    'aeolus', 'arian', 'analannie', 'babe', 'bang', 'banger', 'banging', 'beater', 'bod', 'bodily',
    'booby', 'booger', 'bookie', 'bootee', 'bosom', 'bosomy', 'click', 'climax', 'cockeye',
    'cockfight', 'cocky', 'cox', 'commie', 'cummin', 'dike', 'dingle', 'dillweed', 'domination',
    'dopey', 'dummy', 'enlargement', 'erect', 'erection', 'escort', 'feak', 'feck', 'flamer',
    'flange', 'flasher', 'floozy', 'footlicker', 'foursome', 'gaj', 'gash', 'geezer', 'groomer',
    'gummer', 'harem', 'hobo', 'hoe', 'homey', 'hooter', 'jackass', 'jigger', 'jiggy', 'knob',
    'loin', 'looser', 'loser', 'napalm', 'nimrod', 'ninny', 'nob', 'organ', 'pawn', 'pasty',
    'penthouse', 'pollock', 'prig', 'prude', 'punky', 'quiff', 'racy', 'redleg', 'revue', 'rump',
    'scantily', 'scat', 'seaman', 'sloper', 'slopy', 'snatch', 'souse', 'spook', 'spunk',
    'stringer', 'thrust', 'tramp', 'triplex', 'trojan', 'tuckahoe', 'vixen', 'virgin', 'wad',
    'wang', 'wench', 'whiz', 'willies', 'willy', 'woody', 'wuss', 'clansman', 'clanswoman',
    'niggard', 'niggardly', 'niggardliness', 'niggle', 'niggling',
    // mild words (Moderate lets these through)
    'baldy', 'boob', 'boody', 'booty', 'booze', 'boozer', 'boozy', 'bra', 'brassiere', 'breast',
    'bum', 'butt', 'crap', 'crotch', 'damn', 'damnation', 'damned', 'dong', 'douche', 'drunk',
    'fanny', 'frig', 'hell', 'hooch', 'hump', 'humped', 'idiot', 'jerk', 'kinky', 'lech', 'lube',
    'lust', 'lusty', 'naked', 'nappy', 'poop', 'potty', 'puke', 'screw', 'screwed', 'screwing',
    'sex', 'sexed', 'sexual', 'sexy', 'shag', 'slag', 'slapper', 'sleazy', 'smelly', 'snot',
    'spank', 'steamy', 'strip', 'stroke', 'stupid', 'suck', 'sucker', 'swinger', 'tinkle',
    'topless', 'trashy', 'turd', 'tush', 'twink', 'ugly', 'undies', 'unwed', 'vag', 'vulgar',
    'wedgie',
    // identity terms (not profanity)
    'gay', 'gey', 'jew', 'jewess', 'jihad', 'lesbian', 'moslem', 'queer',
    // drug / substance names
    'bong', 'cocaine', 'ganja', 'hemp', 'heroin', 'hookah', 'marijuana', 'nicotine', 'opiate',
    'opium', 'peyote', 'reefer', 'skag', 'smack', 'stoned', 'toke', 'vodka', 'weed',
    // clinical anatomy / body / medical
    'anus', 'areola', 'areole', 'bestial', 'cervix', 'clitoris', 'ejaculate', 'enema',
    'excrement', 'fecal', 'feces', 'foreskin', 'genital', 'genitals', 'glans', 'gonad', 'herpes',
    'hymen', 'labia', 'lactate', 'libido', 'menses', 'menstruate', 'menstruation', 'nipple',
    'nude', 'nudity', 'nymph', 'oral', 'orally', 'ovary', 'ovum', 'penial', 'penile', 'penis',
    'phallic', 'premature', 'pubes', 'pubic', 'pubis', 'rectal', 'rectum', 'rectus', 'scrotum',
    'semen', 'sperm', 'syphilis', 'teat', 'teste', 'testee', 'testes', 'testicle', 'testis',
    'urethra', 'urinal', 'urinate', 'urine', 'uterus', 'vagina', 'vaginal', 'vulva', 'womb',
    // second-pass false positives: innocent words & violence terms (not
    // profanity) the raw list swept in
    'boned', 'breeder', 'bung', 'crack', 'cracker', 'hoar', 'hoer', 'homicide', 'murder',
    'suicide', 'torture', 'stabber', 'licking', 'lingerie', 'necked', 'nudger', 'pansy',
    'pantie', 'panties', 'panty', 'penetrate', 'penetration', 'playboy', 'punta', 'puss',
    'racial', 'rigger', 'sanger', 'sappho', 'scum', 'seduce', 'skeet', 'slave', 'snuff',
    'spitter', 'squinty', 'stroking', 'sucking', 'thug', 'violate', 'violation', 'vomit',
    'whacker', 'yeasty',
].map(normalizeToken);

/** quote-aware CSV field-0 extractor. handles "" escapes and embedded
 *  newlines/commas inside quoted fields. returns the first field of each
 *  record. */
function firstFields(text: string): string[] {
    const out: string[] = [];
    let field = '';
    let fieldIndex = 0;
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            if (fieldIndex === 0) out.push(field);
            field = '';
            fieldIndex++;
        } else if (ch === '\n' || ch === '\r') {
            if (field !== '' || fieldIndex > 0) {
                if (fieldIndex === 0) out.push(field);
                field = '';
                fieldIndex = 0;
            }
        } else {
            field += ch;
        }
    }
    if (field !== '' || fieldIndex > 0) {
        if (fieldIndex === 0) out.push(field);
    }
    return out;
}

const raw = readFileSync(SRC, 'utf8');
const allow = new Set(ALLOWLIST);
const words = new Set<string>();
let scanned = 0;
let leetDropped = 0;
for (const cell of firstFields(raw)) {
    scanned++;
    // Only ingest entries that are ALREADY plain a-z (the canonical forms).
    // The list's leetspeak permutations (`p@$$`, `@unt`, `he|2|o`) are
    // deliberately skipped: normalizing them collapses onto innocent words
    // (pass, aunt, hello). Runtime input-normalization recreates the
    // canonical form of any evasion, so as long as the plain-alpha word is
    // present, evasions of it still match.
    const trimmed = cell.trim().toLowerCase();
    if (!/^[a-z]+$/.test(trimmed)) {
        leetDropped++;
        continue;
    }
    const norm = normalizeToken(trimmed);
    if (norm.length < MIN_PROFANITY_LEN || norm.length > MAX_LEN) continue;
    if (allow.has(norm)) continue;
    words.add(norm);
}

const sorted = [...words].sort();
const body = sorted.map((w) => `    ${JSON.stringify(w)},`).join('\n');
const file = `// GENERATED FILE — do not edit by hand.
// Regenerate with: npx tsx scripts/gen-profanity.ts <path-to-profanity.csv>
// Each entry is a normalized token (see normalizeToken in ./profanity.ts).
export const PROFANITY_WORDS: ReadonlySet<string> = new Set([
${body}
]);
`;
writeFileSync(OUT, file);
console.log(
    `scanned ${scanned} records, dropped ${leetDropped} non-alpha (leet) -> ${sorted.length} profanity words (allowlist removed ${allow.size}) -> ${OUT}`,
);
