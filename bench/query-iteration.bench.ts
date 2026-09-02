// ── spike: is structure-of-arrays worth an API break? ────────────────
//
// run: pnpm bench query-iteration
//
// `q.matches` is today an array of per-node tuple arrays (AoS). L7 in
// plan-scene-perf proposes one column array per condition (SoA), which would
// remove per-node tuple allocation but breaks the public shape scripts
// destructure. This measures the ONLY thing that could justify that: read
// speed.
//
// What is actually being compared: the trait objects are scattered heap
// objects either way, so SoA does not linearise the data, only the pointers.
// Per element AoS walks matches slot -> tuple object -> elements store ->
// trait; SoA walks column slot -> trait. The win is one indirection and the
// cache behaviour of the pointer array.
//
// Layout is the whole experiment, so both a fresh build (tuples allocated in
// order, AoS's best case) and a churned build (tuples scattered by add/remove
// cycles, which is what a live scene looks like) are measured.

import { bench, group } from '@pmndrs/labs';

type FakeTrait = { _node: object | null; _def: object | null; _sync: object | undefined; x: number; y: number };

function makeTrait(i: number): FakeTrait {
    return { _node: null, _def: null, _sync: undefined, x: i, y: i * 2 };
}

type Built = { matches: FakeTrait[][]; col0: FakeTrait[]; col1: FakeTrait[] };

/** tuples allocated back to back, nothing between them. AoS's best case. */
function buildFresh(n: number, width: number): Built {
    const matches: FakeTrait[][] = [];
    const col0: FakeTrait[] = [];
    const col1: FakeTrait[] = [];
    for (let i = 0; i < n; i++) {
        const a = makeTrait(i);
        const b = makeTrait(i + 1);
        matches.push(width === 1 ? [a] : [a, b]);
        col0.push(a);
        col1.push(b);
    }
    return { matches, col0, col1 };
}

/**
 * the same content after churn: tuples are allocated interleaved with garbage
 * and with each other's removals, then swap-removed down to `n`, so heap order
 * and iteration order have fully diverged.
 */
function buildChurned(n: number, width: number): Built {
    const matches: FakeTrait[][] = [];
    const col0: FakeTrait[] = [];
    const col1: FakeTrait[] = [];
    const junk: object[] = [];
    for (let i = 0; i < n * 3; i++) {
        const a = makeTrait(i);
        const b = makeTrait(i + 1);
        junk.push({ pad: i, more: [i, i + 1, i + 2] });
        matches.push(width === 1 ? [a] : [a, b]);
        col0.push(a);
        col1.push(b);
    }
    // swap-remove down to n, exactly as removeNodeFromQuery does
    let len = matches.length;
    let seed = 12345;
    while (len > n) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const i = seed % len;
        const last = len - 1;
        matches[i] = matches[last]!;
        col0[i] = col0[last]!;
        col1[i] = col1[last]!;
        len--;
    }
    matches.length = len;
    col0.length = len;
    col1.length = len;
    junk.length = 0;
    return { matches, col0, col1 };
}

let sink = 0;

for (const layout of ['fresh', 'churned'] as const) {
    const build = layout === 'fresh' ? buildFresh : buildChurned;

    for (const n of [1_000, 10_000]) {
        group(`query iteration: ${layout}, ${n} matches, width 2 @query @read`, () => {
            const { matches, col0, col1 } = build(n, 2);

            bench('AoS destructured (today’s script idiom)', function* () {
                yield () => {
                    let acc = 0;
                    for (const [a, b] of matches) acc += a!.x + b!.y;
                    sink += acc;
                };
            });

            // splits the destructured idiom's cost: for-of over the array vs
            // array-destructuring each element.
            bench('AoS for-of, no destructure', function* () {
                yield () => {
                    let acc = 0;
                    for (const t of matches) acc += t[0]!.x + t[1]!.y;
                    sink += acc;
                };
            });

            bench('AoS indexed + destructure element', function* () {
                yield () => {
                    let acc = 0;
                    for (let i = 0; i < matches.length; i++) {
                        const [a, b] = matches[i]!;
                        acc += a!.x + b!.y;
                    }
                    sink += acc;
                };
            });

            bench('AoS indexed', function* () {
                yield () => {
                    let acc = 0;
                    for (let i = 0; i < matches.length; i++) {
                        const t = matches[i]!;
                        acc += t[0]!.x + t[1]!.y;
                    }
                    sink += acc;
                };
            });

            bench('SoA indexed, both columns', function* () {
                yield () => {
                    let acc = 0;
                    for (let i = 0; i < col0.length; i++) acc += col0[i]!.x + col1[i]!.y;
                    sink += acc;
                };
            });

            bench('AoS indexed, one column read', function* () {
                yield () => {
                    let acc = 0;
                    for (let i = 0; i < matches.length; i++) acc += matches[i]![0]!.x;
                    sink += acc;
                };
            });

            bench('SoA indexed, one column read', function* () {
                yield () => {
                    let acc = 0;
                    for (let i = 0; i < col0.length; i++) acc += col0[i]!.x;
                    sink += acc;
                };
            });
        });
    }
}

process.on('exit', () => {
    if (sink === -1) console.log('unreachable');
});

/**
 * the decisive sweep: a layout win only matters if it survives real per-element
 * work. `weight` is roughly how many flops a system does per match, from a
 * trivial read (the most flattering case for SoA) up to a physics-step-sized
 * body. If the advantage collapses by the middle of this range, the layout is
 * not what a real frame is spending its time on.
 */
function work(t: FakeTrait, u: FakeTrait, weight: number): number {
    let v = t.x + u.y;
    for (let k = 0; k < weight; k++) v = v * 1.000001 + (v > 1e9 ? -1e9 : 0.5);
    return v;
}

for (const weight of [0, 8, 32, 128]) {
    group(`query iteration: body weight ${weight}, churned, 10000 matches @query @read`, () => {
        const { matches, col0, col1 } = buildChurned(10_000, 2);

        bench('AoS indexed', function* () {
            yield () => {
                let acc = 0;
                for (let i = 0; i < matches.length; i++) {
                    const t = matches[i]!;
                    acc += work(t[0]!, t[1]!, weight);
                }
                sink += acc;
            };
        });

        bench('SoA indexed', function* () {
            yield () => {
                let acc = 0;
                for (let i = 0; i < col0.length; i++) acc += work(col0[i]!, col1[i]!, weight);
                sink += acc;
            };
        });
    });
}
