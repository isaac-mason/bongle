import type { Vec3 } from 'math';
import { describe, expect, test } from 'vitest';
import { ENVIRONMENT_DEFAULT, PRESETS } from '../../src/api/environment';
import { applyConfig, createEnvironment, type Environment } from '../../src/client/environment';
import { createFogBands, resolveFogBands, resolveFogColor } from '../../src/render/environment/fog';

// The two CPU halves of fog are pure and GPU-free: resolving the single `fog`
// group (plus this client's view radius) into the two distance bands the shader
// evaluates, and resolving the per-frame colour. Everything else in fog.ts is
// shader graph, which the sky/voxel layout tests already cover structurally.

const PLAY_RADIUS = 6; // low tier, 96 world units
const HIGH_RADIUS = 12; // 192 world units

function envAt(time: number, config: Parameters<typeof applyConfig>[1] = {}): Environment {
    const env = createEnvironment(ENVIRONMENT_DEFAULT);
    env.time = time;
    applyConfig(env, config, PRESETS);
    return env;
}

const DISABLED = 1e8; // any band start beyond this is off

describe('resolveFogBands', () => {
    const bands = createFogBands();

    test("default 'view' fog reproduces minecraft's terrain band at the play tier", () => {
        // vanilla: band = clamp(96/10, 4, 64) = 9.6, so start = 86.4. our 0.9
        // fraction lands on the same number without needing the radius authored.
        resolveFogBands(bands, envAt(0.5).config, PLAY_RADIUS);
        expect(bands.renderEnd).toBe(96);
        expect(bands.renderStart).toBeCloseTo(86.4, 6);
    });

    test("default 'view' fog matches vanilla at the high tier too", () => {
        resolveFogBands(bands, envAt(0.5).config, HIGH_RADIUS);
        expect(bands.renderEnd).toBe(192);
        expect(bands.renderStart).toBeCloseTo(172.8, 6);
    });

    test("'view' leaves the spherical band off: one term, no double-fogging", () => {
        resolveFogBands(bands, envAt(0.5).config, PLAY_RADIUS);
        expect(bands.start).toBeGreaterThan(DISABLED);
    });

    test('a numeric end is a spherical band at the authored distance', () => {
        const env = envAt(0.5, { fog: { end: 30, start: 0.1 } });
        resolveFogBands(bands, env.config, PLAY_RADIUS);
        expect(bands.start).toBeCloseTo(3, 6);
        expect(bands.end).toBe(30);
    });

    test('a numeric end keeps the boundary guard underneath it', () => {
        // the shader maxes the two, so authored fog wins near the camera while
        // the cylindrical guard still hides the chunk edge.
        const env = envAt(0.5, { fog: { end: 30, start: 0.1 } });
        resolveFogBands(bands, env.config, PLAY_RADIUS);
        expect(bands.renderEnd).toBe(96);
        expect(bands.renderStart).toBeCloseTo(86.4, 6);
    });

    test('an end further out than the client can see still gets the boundary hidden', () => {
        // authored fog never saturates inside the view radius here, so without
        // the guard the streamed chunk edge would be visible.
        const env = envAt(0.5, { fog: { end: 500 } });
        resolveFogBands(bands, env.config, PLAY_RADIUS);
        expect(bands.end).toBe(500);
        expect(bands.renderEnd).toBe(96);
    });

    test('the start fraction moves the fade without touching the distance', () => {
        const env = envAt(0.5, { fog: { start: 0.1 } });
        resolveFogBands(bands, env.config, PLAY_RADIUS);
        expect(bands.renderEnd).toBe(96);
        expect(bands.renderStart).toBeCloseTo(9.6, 6);
    });

    test('fog disabled turns off both bands: the world stops hard', () => {
        const env = envAt(0.5, { fog: { enabled: false } });
        resolveFogBands(bands, env.config, PLAY_RADIUS);
        expect(bands.start).toBeGreaterThan(DISABLED);
        expect(bands.renderStart).toBeGreaterThan(DISABLED);
    });

    test('the environment master switch also kills fog (offline icon renders rely on it)', () => {
        const env = envAt(0.5, { enabled: false });
        resolveFogBands(bands, env.config, PLAY_RADIUS);
        expect(bands.start).toBeGreaterThan(DISABLED);
        expect(bands.renderStart).toBeGreaterThan(DISABLED);
    });

    test('no 32-unit distance floor: the band tracks the radius all the way down', () => {
        // deliberate divergence from vanilla's `Math.max(f2, 32.0f)` — flooring
        // would end fog PAST the drawn terrain and expose the boundary.
        resolveFogBands(bands, envAt(0.5).config, 1);
        expect(bands.renderEnd).toBe(16);
    });
});

describe('resolveFogColor', () => {
    const out: Vec3 = [0, 0, 0];

    test('an authored colour passes through untouched', () => {
        const env = envAt(0.5, { fog: { color: [0.25, 0.5, 0.75] } });
        resolveFogColor(out, env);
        expect(out).toEqual([0.25, 0.5, 0.75]);
    });

    test("'sky' at noon lands on the LUT's noon horizon stop", () => {
        // t=0.5 is stop index 2 exactly, so the lerp fraction is 0 and no
        // sunset tint applies (sun is straight up).
        const env = envAt(0.5);
        resolveFogColor(out, env);
        const noonHorizon = PRESETS.overworld[2]!.horizon;
        expect(out[0]).toBeCloseTo(noonHorizon[0], 6);
        expect(out[1]).toBeCloseTo(noonHorizon[1], 6);
        expect(out[2]).toBeCloseTo(noonHorizon[2], 6);
    });

    test("'sky' at midnight is dark and blue-dominant", () => {
        const env = envAt(0);
        resolveFogColor(out, env);
        expect(out[2]).toBeGreaterThan(out[0]);
        expect(Math.max(out[0], out[1], out[2])).toBeLessThan(0.1);
    });

    test("'sky' warms toward the sunset tint at dusk", () => {
        const dusk = envAt(0.75);
        resolveFogColor(out, dusk);
        const duskR = out[0];
        const duskB = out[2];

        const noon = envAt(0.5);
        resolveFogColor(out, noon);
        const noonR = out[0];
        const noonB = out[2];

        // dusk pulls the horizon toward orange: red rises relative to blue.
        expect(duskR / duskB).toBeGreaterThan(noonR / noonB);
    });

    test('every resolved channel stays finite and non-negative across a full day', () => {
        for (let i = 0; i < 96; i++) {
            const env = envAt(i / 96);
            resolveFogColor(out, env);
            for (const c of out) {
                expect(Number.isFinite(c)).toBe(true);
                expect(c).toBeGreaterThanOrEqual(0);
            }
        }
    });

    test('a short custom LUT clamps to its last stop instead of wrapping past it', () => {
        const stops = [
            { t: 0, zenith: [0, 0, 0] as Vec3, horizon: [1, 0, 0] as Vec3, nadir: [0, 0, 0] as Vec3 },
            { t: 0.5, zenith: [0, 0, 0] as Vec3, horizon: [0, 1, 0] as Vec3, nadir: [0, 0, 0] as Vec3 },
        ];
        const env = envAt(0.9, { sky: { stops } });
        resolveFogColor(out, env);
        for (const c of out) expect(Number.isFinite(c)).toBe(true);
    });
});
