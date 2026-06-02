// ── e2e test setup ──────────────────────────────────────────────────
//
// vitest setup file for e2e tests. runs before any test file imports.
// installs happy-dom (browser DOM) and webgpu stubs so the full engine
// can run headless in node.

import { installWebGPUStub } from './webgpu-stub';

// install webgpu stub onto the happy-dom globals.
// happy-dom is configured via vitest's `environment: 'happy-dom'`
// in the vitest config — it provides window, document,
// HTMLCanvasElement, navigator, etc. we just layer the gpu stub on top.
installWebGPUStub();

// happy-dom doesn't implement Web Audio. provide a minimal AudioContext
// stub so Audio.loadResources() can construct one and the empty-manifest
// path returns a live (no-op) resources object.
if (typeof globalThis.window !== 'undefined' && !('AudioContext' in globalThis.window)) {
    const param = (): any => ({
        value: 0,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
        setTargetAtTime: () => {},
        cancelScheduledValues: () => {},
    });
    class StubAudioContext {
        sampleRate: number;
        destination = {};
        listener = {
            positionX: param(), positionY: param(), positionZ: param(),
            forwardX: param(), forwardY: param(), forwardZ: param(),
            upX: param(), upY: param(), upZ: param(),
        };
        currentTime = 0;
        state = 'running';
        constructor(opts?: { sampleRate?: number }) {
            this.sampleRate = opts?.sampleRate ?? 48000;
        }
        decodeAudioData(_bytes: ArrayBuffer): Promise<unknown> { return Promise.resolve({}); }
        resume(): Promise<void> { return Promise.resolve(); }
        createGain() { return { gain: param(), connect: () => {}, disconnect: () => {} }; }
        createBufferSource() {
            return { buffer: null, detune: param(), playbackRate: param(), connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {}, onended: null };
        }
        createPanner() {
            return {
                positionX: param(), positionY: param(), positionZ: param(),
                orientationX: param(), orientationY: param(), orientationZ: param(),
                refDistance: 1, maxDistance: 10000, rolloffFactor: 1, distanceModel: 'inverse',
                connect: () => {}, disconnect: () => {},
            };
        }
    }
    Object.defineProperty(globalThis.window, 'AudioContext', { value: StubAudioContext, writable: true });
}

// happy-dom doesn't implement devicePixelRatio — default to 1
if (typeof globalThis.window !== 'undefined' && !('devicePixelRatio' in globalThis.window)) {
    Object.defineProperty(globalThis.window, 'devicePixelRatio', { value: 1, writable: true });
}

// happy-dom may not set innerWidth/innerHeight — provide defaults
if (typeof globalThis.window !== 'undefined') {
    if (!globalThis.window.innerWidth) {
        Object.defineProperty(globalThis.window, 'innerWidth', { value: 800, writable: true });
    }
    if (!globalThis.window.innerHeight) {
        Object.defineProperty(globalThis.window, 'innerHeight', { value: 600, writable: true });
    }
}
