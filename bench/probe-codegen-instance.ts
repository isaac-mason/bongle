// would new Function codegen beat cloning a fast template?
// run: node --allow-natives-syntax --import tsx bench/probe-codegen-instance.ts

const hasFastProperties = new Function('a', 'return %HasFastProperties(a);') as (a: object) => boolean;

type Body = Record<string, unknown>;

const transformBody: Body = {
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    teleport: 0,
    worldPosition: [0, 0, 0],
    worldQuaternion: [0, 0, 0, 1],
    worldScale: [1, 1, 1],
    worldMatrix: new Array(16).fill(0),
    worldChunk: null,
    interpolatedWorldPosition: null,
    interpolatedWorldQuaternion: null,
    interpolatedWorldScale: null,
    interpolatedWorldMatrix: null,
    lastTeleport: 0,
    _children: [],
    _parent: null,
    _dirty: 31,
    _interpolated: 0,
    interpolate: 0,
    prevPosition: null,
    prevQuaternion: null,
    _remoteInterpolation: null,
    _correctionFrames: 0,
    _correctionTarget: null,
    _correctionTargetQuat: null,
    _version: 0,
};
const meshBody: Body = { visible: true, unlit: 0, light: [0, 0, 0, 0], _version: 0 };

function cloneValue(v: unknown): unknown {
    return Array.isArray(v) ? v.slice() : v;
}

/** current: one fast template per def, cloned per instance. */
function templateBuilder(body: Body): () => Body {
    const seed: Body = { _node: null, _def: null, _sync: undefined };
    const dynamic: string[] = [];
    for (const k of Object.keys(body)) {
        const v = body[k];
        if (v !== null && typeof v === 'object') {
            seed[k] = null;
            dynamic.push(k);
        } else seed[k] = v;
    }
    const template = { ...seed };
    return () => {
        const out = { ...template };
        for (const k of dynamic) out[k] = cloneValue(body[k]);
        return out;
    };
}

/** codegen: one object literal, array defaults emitted inline. */
function codegenBuilder(body: Body): () => Body {
    const parts: string[] = ['_node: null', '_def: null', '_sync: undefined'];
    const extras: unknown[] = [];
    for (const k of Object.keys(body)) {
        const v = body[k];
        const key = JSON.stringify(k);
        if (Array.isArray(v) && v.every((x) => typeof x === 'number')) parts.push(`${key}: [${v.join(',')}]`);
        else if (v !== null && typeof v === 'object') {
            parts.push(`${key}: c(v[${extras.length}])`);
            extras.push(v);
        } else parts.push(`${key}: ${JSON.stringify(v) ?? 'null'}`);
    }
    const make = new Function('c', 'v', `return function () { return { ${parts.join(', ')} }; };`) as (
        c: (x: unknown) => unknown,
        v: unknown[],
    ) => () => Body;
    return make(cloneValue, extras);
}

function timed(label: string, fn: () => unknown, iters = 500000): void {
    let sink = 0;
    for (let i = 0; i < 20000; i++) sink += fn() === null ? 1 : 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += fn() === null ? 1 : 0;
    const t1 = process.hrtime.bigint();
    console.log(`${label.padEnd(40)} ${(Number(t1 - t0) / iters).toFixed(0)} ns  (${sink})`);
}

for (const [name, body] of [
    ['transform (26 fields)', transformBody],
    ['mesh (4 fields)', meshBody],
] as const) {
    const tpl = templateBuilder(body);
    const gen = codegenBuilder(body);
    console.log(`\n── ${name} ──`);
    console.log(`  template fast? ${hasFastProperties(tpl())}   codegen fast? ${hasFastProperties(gen())}`);
    const keysMatch = JSON.stringify(Object.keys(tpl())) === JSON.stringify(Object.keys(gen()));
    console.log(`  same key order? ${keysMatch}`);
    timed('  template clone', tpl);
    timed('  new Function codegen', gen);
    timed('  template clone', tpl);
    timed('  new Function codegen', gen);
}
