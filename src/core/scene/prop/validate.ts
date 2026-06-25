import { enumValue, type Schema } from './prop';

/**
 * a single problem with a value relative to a schema. `path` is the location
 * inside the value tree (empty array = the value itself; nested arrays/objects
 * push numeric/string keys). `severity` distinguishes hard type mismatches from
 * soft constraint violations (e.g. number out of declared range).
 */
export type Issue = {
    path: (string | number)[];
    severity: 'error' | 'warn';
    message: string;
};

/**
 * walk `value` against `schema` and return every divergence. pure — no
 * mutation, no side effects. an empty array means the value conforms.
 *
 * use at boundaries where untrusted data enters the engine (scene file load,
 * trait register-time defaults, inspector commits) — values are *preserved*
 * regardless of issues so the user can see and fix them rather than silently
 * losing the original bytes.
 */
export function validate(schema: Schema, value: unknown): Issue[] {
    const issues: Issue[] = [];
    walk(schema, value, [], issues);
    return issues;
}

function walk(schema: Schema, value: unknown, path: (string | number)[], issues: Issue[]): void {
    switch (schema.type) {
        case 'boolean':
            if (typeof value !== 'boolean') push(issues, path, `expected boolean, got ${describe(value)}`);
            return;
        case 'string':
            if (typeof value !== 'string') push(issues, path, `expected string, got ${describe(value)}`);
            return;
        case 'number':
            if (typeof value !== 'number' || Number.isNaN(value)) {
                push(issues, path, `expected number, got ${describe(value)}`);
                return;
            }
            if (schema.min !== undefined && value < schema.min) push(issues, path, `${value} < min ${schema.min}`, 'warn');
            if (schema.max !== undefined && value > schema.max) push(issues, path, `${value} > max ${schema.max}`, 'warn');
            return;
        case 'vector2':
        case 'vector3':
        case 'vector4':
        case 'quaternion': {
            const len = schema.type === 'vector2' ? 2 : schema.type === 'vector3' ? 3 : 4;
            if (!Array.isArray(value)) {
                push(issues, path, `expected ${schema.type} (array), got ${describe(value)}`);
                return;
            }
            if (value.length !== len) {
                push(issues, path, `expected ${schema.type} length ${len}, got ${value.length}`);
            }
            for (let i = 0; i < Math.min(value.length, len); i++) {
                const v = value[i];
                if (typeof v !== 'number' || Number.isNaN(v)) push(issues, [...path, i], `expected number, got ${describe(v)}`);
            }
            return;
        }
        case 'list': {
            if (!Array.isArray(value)) {
                push(issues, path, `expected list, got ${describe(value)}`);
                return;
            }
            if (schema.length !== undefined && value.length !== schema.length)
                push(issues, path, `expected list of length ${schema.length}, got ${value.length}`);
            for (let i = 0; i < value.length; i++) walk(schema.of, value[i], [...path, i], issues);
            return;
        }
        case 'tuple': {
            if (!Array.isArray(value)) {
                push(issues, path, `expected tuple, got ${describe(value)}`);
                return;
            }
            if (value.length !== schema.of.length)
                push(issues, path, `expected tuple of length ${schema.of.length}, got ${value.length}`);
            for (let i = 0; i < schema.of.length; i++) {
                if (i < value.length) walk(schema.of[i], value[i], [...path, i], issues);
            }
            return;
        }
        case 'object': {
            if (!isPlainObject(value)) {
                push(issues, path, `expected object, got ${describe(value)}`);
                return;
            }
            for (const [k, sub] of Object.entries(schema.fields)) {
                walk(sub, (value as Record<string, unknown>)[k], [...path, k], issues);
            }
            return;
        }
        case 'record': {
            if (!isPlainObject(value)) {
                push(issues, path, `expected record, got ${describe(value)}`);
                return;
            }
            for (const [k, v] of Object.entries(value)) walk(schema.field, v, [...path, k], issues);
            return;
        }
        case 'literal':
            if (value !== schema.value)
                push(issues, path, `expected literal ${JSON.stringify(schema.value)}, got ${describe(value)}`);
            return;
        case 'enumeration': {
            const allowed = schema.values.map(enumValue);
            if (typeof value !== 'string' && typeof value !== 'number') {
                push(issues, path, `expected one of ${allowed.join(', ')}, got ${describe(value)}`);
                return;
            }
            if (!allowed.includes(value)) push(issues, path, `expected one of ${allowed.join(', ')}, got ${describe(value)}`);
            return;
        }
        case 'nullable':
            if (value === null) return;
            walk(schema.of, value, path, issues);
            return;
        case 'optional':
            if (value === undefined) return;
            walk(schema.of, value, path, issues);
            return;
        case 'nullish':
            if (value === null || value === undefined) return;
            walk(schema.of, value, path, issues);
            return;
        case 'mesh':
            // mesh is implicitly nullable — packcat-bridge wraps it as
            // p.nullable(...) and MeshTrait.meshId defaults to null.
            if (value === null) return;
            if (!isPlainObject(value)) {
                push(issues, path, `expected mesh { modelId, meshName } or null, got ${describe(value)}`);
                return;
            }
            if (typeof (value as Record<string, unknown>).modelId !== 'string')
                push(issues, [...path, 'modelId'], `expected string`);
            if (typeof (value as Record<string, unknown>).meshName !== 'string')
                push(issues, [...path, 'meshName'], `expected string`);
            return;
        case 'prefab':
        case 'block':
            if (typeof value !== 'string') push(issues, path, `expected ${schema.type} ref (string), got ${describe(value)}`);
            return;
        case 'union': {
            if (!isPlainObject(value)) {
                push(issues, path, `expected union object, got ${describe(value)}`);
                return;
            }
            const discriminator = (value as Record<string, unknown>)[schema.key];
            const variant = schema.variants.find((v) => {
                const litSchema = v.fields[schema.key];
                return litSchema && litSchema.type === 'literal' && litSchema.value === discriminator;
            });
            if (!variant) {
                push(issues, path, `union discriminator '${schema.key}'=${describe(discriminator)} doesn't match any variant`);
                return;
            }
            walk(variant, value, path, issues);
            return;
        }
    }
}

function push(issues: Issue[], path: (string | number)[], message: string, severity: 'error' | 'warn' = 'error'): void {
    issues.push({ path, severity, message });
}

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value === 'string') return `string("${value.length > 24 ? `${value.slice(0, 24)}…` : value}")`;
    if (typeof value === 'object') return 'object';
    return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * format an issue path for log/UI display. e.g. `position[0]`, `args.color`.
 * empty path returns ''.
 */
export function formatIssuePath(path: (string | number)[]): string {
    let out = '';
    for (const seg of path) {
        if (typeof seg === 'number') out += `[${seg}]`;
        else out += out ? `.${seg}` : seg;
    }
    return out;
}
