// sanity: does `mat4.create()` seed the affine slots composeWorldMatrix rewrites every call?
import { mat4 } from 'math';
const m = mat4.create();
console.log('mat4.create() =', JSON.stringify(m));
console.log('affine slots already correct:', m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1);
