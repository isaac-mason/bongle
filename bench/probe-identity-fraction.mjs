// What fraction of a real avatar's TransformTraits have an identity local?
//
//   node bench/probe-identity-fraction.mjs avatars/boy/boy.glb [more.glb ...]
//
// Decides whether godot's `fti_is_identity_xform` fast path is worth porting. The engine
// already elides TransformTrait for identity non-mesh non-animated nodes
// (`build-runtime-handle.ts`), so only nodes surviving that predicate can benefit, and
// this counts them against the same rule.
//
// Also counts translation-only locals (identity rotation + unit scale, non-zero
// translation). Those can skip the 3x3 multiply and just offset the parent's translation,
// which is a cheaper compose than the general case without needing full identity.

import fs from 'node:fs';

// character.ts rewrites these bones' quaternions every frame regardless of clips
const LOCOMOTION = new Set(['waist', 'leg_left', 'leg_right', 'arm_left', 'arm_right', 'head']);

const EPS = 1e-6;
const near = (a, b) => Math.abs(a - b) < EPS;
const isIdentityQuat = (q) => !q || (near(q[0], 0) && near(q[1], 0) && near(q[2], 0) && near(Math.abs(q[3]), 1));
const isUnitScale = (s) => !s || (near(s[0], 1) && near(s[1], 1) && near(s[2], 1));
const isZeroPos = (t) => !t || (near(t[0], 0) && near(t[1], 0) && near(t[2], 0));

function readGlbJson(file) {
    const buf = fs.readFileSync(file);
    if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a glb`);
    let offset = 12;
    while (offset < buf.length) {
        const len = buf.readUInt32LE(offset);
        const type = buf.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (type === 0x4e4f534a) return JSON.parse(buf.subarray(start, start + len).toString('utf8'));
        offset = start + len;
    }
    throw new Error(`${file}: no JSON chunk`);
}

let totals = { nodes: 0, transforms: 0, identity: 0, translationOnly: 0, general: 0 };

for (const file of process.argv.slice(2)) {
    const gltf = readGlbJson(file);
    const nodes = gltf.nodes ?? [];

    // animation channel targets, matching `animated` in hydrateRuntimeHandle
    const animated = new Set();
    for (const clip of gltf.animations ?? []) {
        for (const ch of clip.channels ?? []) {
            if (ch.target?.node !== undefined) animated.add(ch.target.node);
        }
    }

    let transforms = 0;
    let identity = 0;
    let translationOnly = 0;
    let rotatedAtRuntime = 0;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        // a node with a baked `matrix` is never identity-detected by the loader path
        const idTRS = n.matrix === undefined && isZeroPos(n.translation) && isIdentityQuat(n.rotation) && isUnitScale(n.scale);
        const hasMesh = n.mesh !== undefined;
        // the exact predicate from build-runtime-handle.ts
        if (!(hasMesh || animated.has(i) || !idTRS)) continue;
        transforms++;
        if (idTRS) identity++;
        else if (n.matrix === undefined && isIdentityQuat(n.rotation) && isUnitScale(n.scale)) translationOnly++;
        // at runtime these gain a rotation: glTF animation targets, plus the bones
        // character.ts drives procedurally every frame (applyLimb x5 + head look).
        if (animated.has(i) || LOCOMOTION.has(n.name)) rotatedAtRuntime++;
    }

    const general = transforms - identity - translationOnly;
    totals = {
        nodes: totals.nodes + nodes.length,
        transforms: totals.transforms + transforms,
        identity: totals.identity + identity,
        translationOnly: totals.translationOnly + translationOnly,
        general: totals.general + general,
    };
    const pct = (n) => (transforms ? ((n / transforms) * 100).toFixed(1) : '0.0').padStart(5);
    console.log(
        `${file.padEnd(46)} ${String(nodes.length).padStart(4)} nodes  ${String(transforms).padStart(4)} transforms  ` +
            `identity ${pct(identity)}%  trans-only ${pct(translationOnly)}%  rotated-at-runtime ${pct(rotatedAtRuntime)}%  ` +
            `=> fast at runtime ${pct(transforms - rotatedAtRuntime)}%`,
    );
}

const t = totals.transforms;
if (t > 0) {
    console.log(
        `\nTOTAL  ${totals.nodes} nodes, ${t} transforms:  ` +
            `identity ${((totals.identity / t) * 100).toFixed(1)}%  ` +
            `translation-only ${((totals.translationOnly / t) * 100).toFixed(1)}%  ` +
            `general ${((totals.general / t) * 100).toFixed(1)}%\n`,
    );
}
