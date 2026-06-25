// ── webgpu-stub.ts ──────────────────────────────────────────────────
//
// minimal fake webgpu api so gpucat can construct, init, and "render"
// without a real gpu. every object is a thin proxy that records nothing
// and returns more stubs. this is NOT a conformance implementation —
// just enough surface area for the engine's headless test harness.
//
// install via: installWebGPUStub() before any gpucat imports.

// ── helpers ─────────────────────────────────────────────────────────

const noop = () => {};

// returns a proxy that returns stubs for any property access.
// methods return the proxy itself (for chaining) or another stub.
function deepStub(label = 'stub'): any {
    // use a function as the proxy target so the stub is callable
    const cache: Record<string | symbol, any> = {};
    const fn = () => deepStub(`${label}()`);
    return new Proxy(fn, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive) return () => `[${label}]`;
            if (prop === Symbol.iterator) return undefined;
            if (prop === 'then') return undefined; // prevent promise detection
            if (prop === 'label') return label;
            if (prop === 'size') return 0;
            if (prop === 'length') return 0;
            if (prop === 'prototype') return undefined;

            // cache so identity checks work (e.g. === comparisons)
            if (typeof prop === 'string' && !(prop in cache)) {
                cache[prop] = deepStub(`${label}.${prop}`);
            }
            return cache[prop as string];
        },
        set(_t, prop, value) {
            cache[prop as string] = value;
            return true;
        },
        apply() {
            return deepStub(`${label}()`);
        },
    });
}

// ── gpu texture stub ────────────────────────────────────────────────

function createGPUTextureStub(): any {
    return {
        createView: () => deepStub('GPUTextureView'),
        destroy: noop,
        width: 800,
        height: 600,
        format: 'bgra8unorm',
        usage: 0,
        label: '',
    };
}

// ── gpu device stub ─────────────────────────────────────────────────

function createGPUDeviceStub(): any {
    const device: Record<string, any> = {
        // feature detection
        features: new Set<string>(),
        limits: STUB_LIMITS,

        // resource creation — all return stubs
        createBuffer: () => deepStub('GPUBuffer'),
        createTexture: () => createGPUTextureStub(),
        createSampler: () => deepStub('GPUSampler'),
        createShaderModule: () => {
            const mod = deepStub('GPUShaderModule');
            mod.getCompilationInfo = () => Promise.resolve({ messages: [] });
            return mod;
        },
        createBindGroupLayout: () => deepStub('GPUBindGroupLayout'),
        createPipelineLayout: () => deepStub('GPUPipelineLayout'),
        createBindGroup: () => deepStub('GPUBindGroup'),
        createRenderPipeline: () => deepStub('GPURenderPipeline'),
        createComputePipeline: () => deepStub('GPUComputePipeline'),
        createRenderPipelineAsync: () => Promise.resolve(deepStub('GPURenderPipeline')),
        createComputePipelineAsync: () => Promise.resolve(deepStub('GPUComputePipeline')),
        createCommandEncoder: () => createGPUCommandEncoderStub(),
        createQuerySet: () => deepStub('GPUQuerySet'),
        createRenderBundleEncoder: () => deepStub('GPURenderBundleEncoder'),

        // error scopes
        pushErrorScope: noop,
        popErrorScope: () => Promise.resolve(null),

        // queue
        queue: {
            submit: noop,
            writeBuffer: noop,
            writeTexture: noop,
            copyExternalImageToTexture: noop,
            onSubmittedWorkDone: () => Promise.resolve(),
            label: 'queue',
        },

        // device lost — never resolves in test
        lost: new Promise<any>(() => {}),

        destroy: noop,
        label: 'test-device',

        // event target stubs
        addEventListener: noop,
        removeEventListener: noop,
        dispatchEvent: () => true,
    };

    return device;
}

// ── gpu command encoder stub ────────────────────────────────────────

function createGPURenderPassEncoderStub(): any {
    return {
        setPipeline: noop,
        setBindGroup: noop,
        setVertexBuffer: noop,
        setIndexBuffer: noop,
        draw: noop,
        drawIndexed: noop,
        drawIndirect: noop,
        drawIndexedIndirect: noop,
        setViewport: noop,
        setScissorRect: noop,
        setBlendConstant: noop,
        setStencilReference: noop,
        executeBundles: noop,
        beginOcclusionQuery: noop,
        endOcclusionQuery: noop,
        end: noop,
        label: 'render-pass',
    };
}

function createGPUComputePassEncoderStub(): any {
    return {
        setPipeline: noop,
        setBindGroup: noop,
        dispatchWorkgroups: noop,
        dispatchWorkgroupsIndirect: noop,
        end: noop,
        label: 'compute-pass',
    };
}

function createGPUCommandEncoderStub(): any {
    return {
        beginRenderPass: () => createGPURenderPassEncoderStub(),
        beginComputePass: () => createGPUComputePassEncoderStub(),
        copyBufferToBuffer: noop,
        copyBufferToTexture: noop,
        copyTextureToBuffer: noop,
        copyTextureToTexture: noop,
        clearBuffer: noop,
        resolveQuerySet: noop,
        finish: () => deepStub('GPUCommandBuffer'),
        label: 'encoder',
    };
}

// ── gpu canvas context stub ─────────────────────────────────────────

function createGPUCanvasContextStub(): any {
    return {
        configure: noop,
        unconfigure: noop,
        getCurrentTexture: () => createGPUTextureStub(),
        canvas: null, // will be set by caller
    };
}

// ── gpu adapter stub ────────────────────────────────────────────────

// realistic-ish numeric limits — engine code does arithmetic on these
// (Math.min, *, /), so they MUST be numbers, not deepStub proxies.
const STUB_LIMITS = {
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxBufferSize: 256 * 1024 * 1024,
    maxComputeWorkgroupsPerDimension: 65535,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupSizeY: 256,
    maxComputeWorkgroupSizeZ: 64,
};

function createGPUAdapterStub(): any {
    return {
        features: new Set<string>(),
        limits: STUB_LIMITS,
        info: { vendor: 'test', architecture: 'test', device: 'test', description: 'test stub' },
        isFallbackAdapter: false,
        requestDevice: () => Promise.resolve(createGPUDeviceStub()),
        requestAdapterInfo: () => Promise.resolve({ vendor: 'test', architecture: 'test' }),
    };
}

// ── navigator.gpu stub ──────────────────────────────────────────────

function createGPUStub(): any {
    return {
        requestAdapter: () => Promise.resolve(createGPUAdapterStub()),
        getPreferredCanvasFormat: () => 'bgra8unorm',
        wgslLanguageFeatures: new Set<string>(),
    };
}

// ── install ─────────────────────────────────────────────────────────

/**
 * install the webgpu stub onto globalThis.navigator.gpu and patch
 * HTMLCanvasElement.prototype.getContext to return a fake GPUCanvasContext
 * for the 'webgpu' context type.
 *
 * call this ONCE before any gpucat imports in your test setup file.
 */
export function installWebGPUStub(): void {
    const g = globalThis as any;

    // navigator.gpu
    if (!g.navigator) g.navigator = {};
    g.navigator.gpu = createGPUStub();

    // GPUBufferUsage / GPUTextureUsage constants (gpucat references these)
    if (!g.GPUBufferUsage) {
        g.GPUBufferUsage = {
            MAP_READ: 0x0001,
            MAP_WRITE: 0x0002,
            COPY_SRC: 0x0004,
            COPY_DST: 0x0008,
            INDEX: 0x0010,
            VERTEX: 0x0020,
            UNIFORM: 0x0040,
            STORAGE: 0x0080,
            INDIRECT: 0x0100,
            QUERY_RESOLVE: 0x0200,
        };
    }

    if (!g.GPUTextureUsage) {
        g.GPUTextureUsage = {
            COPY_SRC: 0x01,
            COPY_DST: 0x02,
            TEXTURE_BINDING: 0x04,
            STORAGE_BINDING: 0x08,
            RENDER_ATTACHMENT: 0x10,
        };
    }

    if (!g.GPUShaderStage) {
        g.GPUShaderStage = {
            VERTEX: 0x1,
            FRAGMENT: 0x2,
            COMPUTE: 0x4,
        };
    }

    if (!g.GPUMapMode) {
        g.GPUMapMode = {
            READ: 0x0001,
            WRITE: 0x0002,
        };
    }

    if (!g.GPUColorWrite) {
        g.GPUColorWrite = {
            RED: 0x1,
            GREEN: 0x2,
            BLUE: 0x4,
            ALPHA: 0x8,
            ALL: 0xf,
        };
    }

    // patch HTMLCanvasElement.prototype.getContext to handle 'webgpu'
    if (typeof g.HTMLCanvasElement !== 'undefined') {
        const origGetContext = g.HTMLCanvasElement.prototype.getContext;
        g.HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
            if (type === 'webgpu') {
                const ctx = createGPUCanvasContextStub();
                ctx.canvas = this;
                return ctx;
            }
            return origGetContext?.call(this, type, ...args) ?? null;
        };
    }
}
