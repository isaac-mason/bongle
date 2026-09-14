// a minimal gui for tweaking values and watching data — the widget toolkit the
// client debug dashboard (client/ui/dashboard.ts) is built from.
//
// vendored from dashcat (https://github.com/isaac-mason/dashcat, MIT) at
// 303478b. zero deps, plain DOM. edit it here; it is engine source now.

// the mount surface options
export type { Accessor, AddOptions, Container, ControlName, Folder, FolderOptions, TabGroup, TilesOptions } from './container';
export type { Base, Context, Control, Handle } from './control';
// authoring a custom control: `const c: Control<T> = (ctx, prop) => { const b = base(...); ... }`
export { base } from './control';
export { el, on } from './dom';
export type { Formatter } from './format';
export { bytes, duration, percent, si, suffix } from './format';
export type { Dashboard, DashboardOptions, Panel, PanelOptions } from './layout/dock';
export { dashboard } from './layout/dock';
// realtime watch widgets
export type { BarsOptions } from './monitors/bars';
export type { FlameFrame, FlameOptions } from './monitors/flame';
export type { GaugeOptions } from './monitors/gauge';
export type { GraphOptions } from './monitors/graph';
export type { HistogramOptions } from './monitors/histogram';
export type { LinesOptions } from './monitors/lines';
export type { Log, LogEntry, LogOptions } from './monitors/log';
export type { MonitorOptions } from './monitors/monitor';
export type { SeriesOptions } from './monitors/series';
export type { Threshold } from './monitors/shared';
export { hashColor, hashHue } from './monitors/shared';
export type { StatOptions } from './monitors/stat';
export type { StatesOptions, StateValue } from './monitors/states';
export type { PopoverOptions } from './popover';
export { openPopover, tooltip } from './popover';
export type { Prop } from './prop';
export { scrub } from './scrub';
export { css, injectStyles } from './theme';
