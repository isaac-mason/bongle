// the `control` namespace — every mountable widget. re-exported from the root as
// `export * as control`, so consumers write `control.vec3(...)` / `control.euler(...)`
// with no clash against math's bare `vec3` / `quat`.

export { graph } from '../monitors/graph';
export { monitor } from '../monitors/monitor';
export { boolean } from './boolean';
export { button, buttonGroup } from './button';
export { color } from './color';
export { element, html } from './html';
export { number, slider } from './number';
export { euler, quaternion } from './rotation';
export { select } from './select';
export { switchControl as switch } from './switch';
export { text } from './text';
export { spherical, vec2, vec3, vec4 } from './vec';
