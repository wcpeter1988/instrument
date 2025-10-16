export type Logger = (message?: any, ...optionalParams: any[]) => void;

export type ParamsSelector = (info: { names: string[]; args: any[]; thisArg: any; label: string }) => Array<string | number> | 'all' | 'none';

export interface InstrumentOptions {
  logger?: Logger;
  label?: string;
  includeThis?: boolean;
  redact?: (key: string, value: unknown) => unknown;
  // Control argument logging
  // - params: choose which params to include by name or index (best-effort name extraction)
  // - logArgs: toggle logging of arguments entirely (default true)
  //   You can also pass a function to decide dynamically per-call.
  params?: Array<string | number> | ParamsSelector;
  logArgs?: boolean;
  // Control return logging (default true). Alias: `return` supported for convenience.
  logReturn?: boolean;
  // eslint-disable-next-line @typescript-eslint/ban-types
  return?: boolean;
  // Emit structured payload per decorated call
  sink?: (payload: LogUnit) => void;
}

const defaultRedact = (_key: string, value: unknown) => value;

function formatArgs(args: IArguments | any[], redact: InstrumentOptions['redact']) {
  try {
    return JSON.stringify(Array.from(args), (k, v) => redact?.(k, v) ?? v);
  } catch {
    return '[unserializable arguments]';
  }
}

function safeStringify(value: unknown, redact: InstrumentOptions['redact']) {
  try {
    return JSON.stringify(value, (k, v) => redact?.(k, v) ?? v);
  } catch {
    return '[unserializable return]';
  }
}

function toJSONish(value: unknown, redact: InstrumentOptions['redact']) {
  const s = safeStringify(value, redact);
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Best-effort parameter name extraction from function source string
function getParamNames(fn: Function): string[] | null {
  try {
    const src = Function.prototype.toString.call(fn);
    // match the first parenthesis pair with parameters
    const m = src.match(/^[^(]*\(([^)]*)\)/);
    if (!m) return null;
    const inside = m[1].trim();
    if (!inside) return [];
    return inside
      .split(',')
      .map((s) => s.trim())
      // strip default values
      .map((s) => s.replace(/=.*/, '').trim())
      // remove rest/spread
      .map((s) => s.replace(/^\.{3}/, ''))
      // leave destructuring as-is (won't match provided names)
      .map((s) => s);
  } catch {
    return null;
  }
}

function pickArgs(
  allArgs: any[],
  fn: Function,
  options: InstrumentOptions,
  redact: InstrumentOptions['redact']
) {
  const { logArgs = true, params } = options;
  if (!logArgs) return '[]';
  const names = getParamNames(fn) || [];
  let selectedList: Array<string | number> | 'all' | 'none' | undefined = undefined;
  if (typeof params === 'function') {
    try {
      selectedList = params({ names, args: allArgs, thisArg: undefined, label: options.label || (fn.name || 'anonymous') });
    } catch {
      selectedList = 'all';
    }
  } else {
    selectedList = params;
  }
  if (!selectedList || (Array.isArray(selectedList) && selectedList.length === 0)) return formatArgs(allArgs, redact);
  if (selectedList === 'none') return '[]';
  if (selectedList === 'all') return formatArgs(allArgs, redact);
  // build mapping name -> index
  const selected: any[] = [];
  for (const p of selectedList) {
    if (typeof p === 'number') {
      if (p >= 0 && p < allArgs.length) selected.push(allArgs[p]);
    } else if (typeof p === 'string') {
      const idx = names.indexOf(p);
      if (idx >= 0 && idx < allArgs.length) selected.push(allArgs[idx]);
    }
  }
  return formatArgs(selected, redact);
}

function selectArgs(
  allArgs: any[],
  fn: Function,
  options: InstrumentOptions
) {
  const { logArgs = true, params } = options;
  if (!logArgs) return [] as any[];
  const names = getParamNames(fn) || [];
  let selectedList: Array<string | number> | 'all' | 'none' | undefined = undefined;
  if (typeof params === 'function') {
    try {
      selectedList = params({ names, args: allArgs, thisArg: undefined, label: options.label || (fn.name || 'anonymous') });
    } catch {
      selectedList = 'all';
    }
  } else {
    selectedList = params;
  }
  if (!selectedList || (Array.isArray(selectedList) && selectedList.length === 0)) return Array.from(allArgs);
  if (selectedList === 'none') return [] as any[];
  if (selectedList === 'all') return Array.from(allArgs);
  const selected: any[] = [];
  for (const p of selectedList) {
    if (typeof p === 'number') {
      if (p >= 0 && p < allArgs.length) selected.push(allArgs[p]);
    } else if (typeof p === 'string') {
      const idx = names.indexOf(p);
      if (idx >= 0 && idx < allArgs.length) selected.push(allArgs[idx]);
    }
  }
  return selected;
}

export function logCall<T extends Function>(fn: T, options: InstrumentOptions = {}): T {
  const { logger = console.log, label = fn.name || 'anonymous', includeThis = false, redact = defaultRedact } = options;
  const wrapped: any = function (this: any, ...args: any[]) {
    const callLabel = label;
    const parts: any[] = [];
    parts.push(`[call] ${callLabel}(` + pickArgs(args, fn, options, redact) + ')');
    if (includeThis) {
      parts.push('this=' + safeStringify(this, redact));
    }
    logger(parts.join(' '));
    const result = fn.apply(this, args);
    if (result && typeof (result as any).then === 'function') {
      return (result as any)
        .then((res: any) => {
          const shouldLogReturn = (options.logReturn ?? (options as any).return) !== false;
          if (shouldLogReturn) {
            logger(`[return] ${callLabel} -> ` + safeStringify(res, redact));
          }
          return res;
        })
        .catch((err: any) => {
          logger(`[throw] ${callLabel} !! ` + (err?.stack || String(err)));
          throw err;
        });
    } else {
      const shouldLogReturn = (options.logReturn ?? (options as any).return) !== false;
      if (shouldLogReturn) {
        logger(`[return] ${callLabel} -> ` + safeStringify(result, redact));
      }
      return result;
    }
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  return wrapped as unknown as T;
}
// Decorator-scoped payload logging using AsyncLocalStorage to correlate logVar calls
import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';

export interface LogPayloadArgPair { name: string; value: any }
// Internal aggregate used during call execution
export interface LogPayload {
  label: string;
  args?: LogPayloadArgPair[];
  thisArg?: any;
  vars?: Array<{ name?: string; value: any; at: string }>;
  return?: any;
  error?: string;
  project?: string;
  sessionId?: string;
  start: number;
  end?: number;
  durationMs?: number;
}

// Public log unit shape
export interface LogUnit {
  tagId: string;
  timestamp: number;
  session?: string;
  project?: string;
  payload: {
  args?: LogPayloadArgPair[];
    thisArg?: any;
    vars?: Array<{ name?: string; value: any; at: string }>;
    return?: any;
    error?: string;
    end?: number;
    durationMs?: number;
  };
}

type CallContext = { payload: LogPayload; options: InstrumentOptions };
const callContext = new AsyncLocalStorage<CallContext>();

const defaultSink = (unit: LogUnit) => {
  // Single structured emission per decorated call
  // eslint-disable-next-line no-console
  console.log('[unit]', JSON.stringify(unit));
};

// Session context for correlating instrumentation across calls
export interface InstrumentSession {
  project: string;
  sessionId: string;
  endpoint?: string; // optional datalake endpoint to POST log units
}

const sessionStore = new AsyncLocalStorage<InstrumentSession | undefined>();

export function startInstrumentSession(project: string, sessionId: string, endpoint?: string) {
  // Returns a function to end the session when used manually
  sessionStore.enterWith({ project, sessionId, endpoint });
  return () => sessionStore.enterWith(undefined);
}

export function runInInstrumentSession<T>(project: string, sessionId: string, fn: () => T, endpoint?: string): T {
  return sessionStore.run({ project, sessionId, endpoint }, fn as any) as unknown as T;
}

export function endInstrumentSession() {
  sessionStore.enterWith(undefined);
}

export function getInstrumentSession(): InstrumentSession | undefined {
  return sessionStore.getStore();
}

export function LogMethod(options: InstrumentOptions = {}) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const original = descriptor.value;
    const label = options.label ?? `${target.constructor?.name || 'Object'}.${propertyKey}`;
    descriptor.value = function (this: any, ...args: any[]) {
      const start = Date.now();
      const sess = getInstrumentSession();
      const sink = options.sink ?? (sess?.endpoint ? endpointSink(sess.endpoint) : defaultSink);
      const payload: LogPayload = { label, start, project: sess?.project, sessionId: sess?.sessionId };
      const ctx: CallContext = { payload, options };
      return callContext.run(ctx, () => {
        try {
          // capture args as name/value pairs using parameter names when available
          const names = getParamNames(original) || [];
          const pairs: LogPayloadArgPair[] = [];
          if (options.logArgs !== false) {
            let selectedList: Array<string | number> | 'all' | 'none' | undefined = undefined;
            if (typeof options.params === 'function') {
              try {
                selectedList = options.params({ names, args, thisArg: this, label });
              } catch {
                selectedList = 'none'; // default to none on failure
              }
            } else if (Array.isArray(options.params)) {
              selectedList = options.params as Array<string | number>;
            } else if (options.params === 'all' || options.params === 'none') {
              selectedList = options.params as 'all' | 'none';
            } else {
              selectedList = 'none'; // default for decorators: log no args unless specified
            }
            if (selectedList && selectedList !== 'all' && selectedList !== 'none' && selectedList.length > 0) {
              for (const p of selectedList) {
                if (typeof p === 'number') {
                  const idx = p;
                  if (idx >= 0 && idx < args.length) {
                    const key = names[idx] || `arg${idx}`;
                    pairs.push({ name: key, value: toJSONish(args[idx], options.redact ?? defaultRedact) });
                  }
                } else if (typeof p === 'string') {
                  const idx = names.indexOf(p);
                  if (idx >= 0 && idx < args.length) {
                    pairs.push({ name: p, value: toJSONish(args[idx], options.redact ?? defaultRedact) });
                  }
                }
              }
            } else if (selectedList === 'all') {
              for (let i = 0; i < args.length; i++) {
                const key = names[i] || `arg${i}`;
                pairs.push({ name: key, value: toJSONish(args[i], options.redact ?? defaultRedact) });
              }
            }
          }
          if (pairs.length) payload.args = pairs;
          if (options.includeThis) payload.thisArg = toJSONish(this, options.redact ?? defaultRedact);
          const result = original.apply(this, args);
          if (isPromiseLike(result)) {
            return (result as Promise<any>)
              .then((res) => {
                const shouldLogReturn = (options.logReturn ?? (options as any).return ?? false) === true;
                if (shouldLogReturn) payload.return = toJSONish(res, options.redact ?? defaultRedact);
                payload.end = Date.now();
                payload.durationMs = payload.end - start;
                const unit: LogUnit = {
                  tagId: payload.label,
                  timestamp: payload.start,
                  session: payload.sessionId,
                  project: payload.project,
                  payload: {
                    args: payload.args,
                    thisArg: payload.thisArg,
                    vars: payload.vars,
                    return: payload.return,
                    error: payload.error,
                    end: payload.end,
                    durationMs: payload.durationMs,
                  },
                };
                sink(unit);
                return res;
              })
              .catch((err) => {
                payload.error = err?.stack || String(err);
                payload.end = Date.now();
                payload.durationMs = payload.end - start;
                const unit: LogUnit = {
                  tagId: payload.label,
                  timestamp: payload.start,
                  session: payload.sessionId,
                  project: payload.project,
                  payload: {
                    args: payload.args,
                    thisArg: payload.thisArg,
                    vars: payload.vars,
                    return: payload.return,
                    error: payload.error,
                    end: payload.end,
                    durationMs: payload.durationMs,
                  },
                };
                sink(unit);
                throw err;
              });
          } else {
            const shouldLogReturn = (options.logReturn ?? (options as any).return ?? false) === true;
            if (shouldLogReturn) payload.return = toJSONish(result, options.redact ?? defaultRedact);
            payload.end = Date.now();
            payload.durationMs = payload.end - start;
            const unit: LogUnit = {
              tagId: payload.label,
              timestamp: payload.start,
              session: payload.sessionId,
              project: payload.project,
              payload: {
                args: payload.args,
                thisArg: payload.thisArg,
                vars: payload.vars,
                return: payload.return,
                error: payload.error,
                end: payload.end,
                durationMs: payload.durationMs,
              },
            };
            sink(unit);
            return result;
          }
        } catch (err: any) {
          payload.error = err?.stack || String(err);
          payload.end = Date.now();
          payload.durationMs = payload.end - start;
          const unit: LogUnit = {
            tagId: payload.label,
            timestamp: payload.start,
            session: payload.sessionId,
            project: payload.project,
            payload: {
              args: payload.args,
              thisArg: payload.thisArg,
              vars: payload.vars,
              return: payload.return,
              error: payload.error,
              end: payload.end,
              durationMs: payload.durationMs,
            },
          };
          sink(unit);
          throw err;
        }
      });
    };
  };
}

export function LogAll(options: InstrumentOptions = {}) {
  return function <T extends { new (...args: any[]): any }>(constructor: T) {
    const propNames = Object.getOwnPropertyNames(constructor.prototype);
    for (const name of propNames) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(constructor.prototype, name);
      if (!desc) continue;
      if (typeof desc.value === 'function') {
        const label = options.label ?? `${constructor.name}.${name}`;
        const decorator = LogMethod({ ...options, label });
        decorator(constructor.prototype, name, desc);
        Object.defineProperty(constructor.prototype, name, desc);
      } else {
        // getters/setters could be wrapped similarly if needed in future
      }
    }
    return constructor;
  };
}

// Shorthand decorator alias for methods
export const Log = LogMethod;
// New preferred names (aliases) for consistency
export const InstrumentMethod = LogMethod;
export const InstrumentAll = LogAll;
export const InstrumentInline = logInline;
export const InstrumentVar = logVar;
export const InstrumentVars = logVars;
export const InstrumentCall = logCall;

// Inline-friendly wrapper that auto-labels with callsite location if label not provided
function deriveCallsiteLabel(fallback: string) {
  const err = new Error();
  const stack = (err.stack || '').split('\n').slice(2); // skip Error line + current function
  const frame = stack.find((l) => !/instrument[\\/].*index\.ts/.test(l) && !/node_modules/.test(l) && !/internal\//.test(l));
  if (!frame) return fallback;
  const m = frame.match(/\(?([^()]+):(\d+):(\d+)\)?/);
  if (!m) return fallback;
  const [, file, line, col] = m;
  return `${fallback}@${file}:${line}:${col}`;
}

function getCallsite() {
  try {
    const err = new Error();
    const stack = (err.stack || '').split('\n').slice(2);
    const frame = stack.find((l) => !/instrument[\\/].*index\.ts/.test(l) && !/node_modules/.test(l) && !/internal\//.test(l));
    if (!frame) return null;
    const m = frame.match(/\(?([^()]+):(\d+):(\d+)\)?/);
    if (!m) return null;
    const [, file, line, col] = m;
    return { file, line: Number(line), col: Number(col) };
  } catch {
    return null;
  }
}

function tryInferVarNameFromSource(cs: { file: string; line: number; col: number }): string | undefined {
  try {
    const text = fs.readFileSync(cs.file, 'utf8');
    const lines = text.split(/\r?\n/);
    const lineStr = lines[cs.line - 1] || '';
    // Find parentheses around the call starting near col
    // Search backwards for '(' and forwards for matching ')'
    let startIdx = cs.col - 1;
    startIdx = Math.max(0, Math.min(startIdx, lineStr.length - 1));
    // Move back to first '(' before or at position
    let lp = lineStr.lastIndexOf('(', startIdx);
    if (lp === -1) return undefined;
    // Extract substring from '(' to end of line and try to find closing ')'
    const rest = lineStr.slice(lp + 1);
    const rpLocal = rest.indexOf(')');
    const argStr = (rpLocal >= 0 ? rest.slice(0, rpLocal) : rest).trim();
    // If multiple args, take the first segment
    const firstArg = argStr.split(',')[0]?.trim() || '';
    // Try to match a simple identifier
    const m = firstArg.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (!m) return undefined;
    return m[0];
  } catch {
    return undefined;
  }
}

export function logInline<T extends Function>(fn: T, options: InstrumentOptions = {}): T {
  const baseLabel = options.label ?? (fn.name || 'anonymous');
  const label = deriveCallsiteLabel(baseLabel);
  return logCall(fn as any, { ...options, label }) as unknown as T;
}

// Log an arbitrary variable/expression and return it unchanged.
// Useful inside decorated methods to "mark" intermediate values.
export function logVar<T>(value: T, name?: string, options: InstrumentOptions = {}): T {
  const store = callContext.getStore();
  if (store) {
    const { payload, options: opt } = store;
    if (!payload.vars) payload.vars = [];
    const cs = getCallsite();
    const rel = cs ? path.relative(process.cwd(), cs.file).split(path.sep).join('/') : 'unknown';
    const inferred = (!name && cs) ? tryInferVarNameFromSource(cs) : undefined;
    const varName = name || inferred || 'var';
    const at = `${varName}@${rel}${cs ? `:${cs.line}:${cs.col}` : ''}`;
    payload.vars.push({ name: varName, value: toJSONish(value, opt.redact ?? defaultRedact), at });
    return value;
  }
  // Fallback standalone logging when not in a decorator context
  const { logger = console.log, redact = defaultRedact } = options;
  const base = options.label ?? (name || 'var');
  const label = deriveCallsiteLabel(base);
  const body = name ? `${name}=` + safeStringify(value, redact) : safeStringify(value, redact);
  logger(`[var] ${label} ` + body);
  return value;
}

// Log multiple variables using their object keys as names.
// Usage: logVars({ prompt, summary })
export function logVars<T extends Record<string, any>>(vars: T, options: InstrumentOptions = {}): T {
  for (const [k, v] of Object.entries(vars)) {
    logVar(v, k, options);
  }
  return vars;
}

// Proxy-based instrumentation for functions, objects, and classes
type AnyFn = (...args: any[]) => any;

function isPromiseLike(v: any) {
  return v && typeof v.then === 'function';
}

export function instrument<T extends object | AnyFn>(
  target: T,
  options: InstrumentOptions = {}
): T {
  const cache = new WeakMap<object, Map<PropertyKey, Function>>();

  const wrapFunction = (fn: AnyFn, label: string, includeThis: boolean) =>
    function (this: any, ...args: any[]) {
      const { logger = console.log, redact = defaultRedact } = options;
      logger(`[call] ${label}(` + formatArgs(args, redact) + ')' + (includeThis ? ' this=' + safeStringify(this, redact) : ''));
      try {
        const result = fn.apply(this, args);
        if (isPromiseLike(result)) {
          return (result as Promise<any>)
            .then((res) => {
              logger(`[return] ${label} -> ` + safeStringify(res, redact));
              return res;
            })
            .catch((err) => {
              logger(`[throw] ${label} !! ` + (err?.stack || String(err)));
              throw err;
            });
        } else {
          logger(`[return] ${label} -> ` + safeStringify(result, redact));
          return result;
        }
      } catch (err: any) {
        const { logger = console.log } = options;
        logger(`[throw] ${label} !! ` + (err?.stack || String(err)));
        throw err;
      }
    };

  const instrumentObject = (obj: any, nameHint?: string): any => {
    return new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        const map = cache.get(target) ?? new Map<PropertyKey, Function>();
        if (!cache.has(target)) cache.set(target, map);
        if (map.has(prop)) return map.get(prop);
        const label = `${nameHint || target?.constructor?.name || 'Object'}.${String(prop)}`;
        const wrapped = wrapFunction(value.bind(target), label, options.includeThis ?? false);
        map.set(prop, wrapped);
        return wrapped;
      },
    });
  };

  if (typeof target === 'function') {
    // Could be a plain function or a class constructor
    try {
      // Detect class by attempting construct; if fails, treat as function
      const isClassLike = /^class\s/.test(Function.prototype.toString.call(target));
      if (isClassLike) {
        return new Proxy(target as AnyFn, {
          construct(Target: any, args: any[], newTarget) {
            const instance = Reflect.construct(Target, args, newTarget);
            return instrumentObject(instance, Target.name);
          },
          apply(fn: AnyFn, thisArg: any, args: any[]) {
            const label = (options.label ?? (fn.name || 'anonymous')) as string;
            return wrapFunction(fn, label, options.includeThis ?? false).apply(thisArg, args);
          },
        }) as unknown as T;
      }
    } catch {
      // Fall back to function handling
    }
    const label = options.label ?? ((target as AnyFn).name || 'anonymous');
    return new Proxy(target as AnyFn, {
      apply(fn: AnyFn, thisArg: any, args: any[]) {
        return wrapFunction(fn, label as string, options.includeThis ?? false).apply(thisArg, args);
      },
    }) as unknown as T;
  }

  // target is object instance
  return instrumentObject(target as object) as T;
}

// Create a sink that posts LogUnits to a datalake-compatible endpoint.
function endpointSink(endpoint: string | undefined) {
  return (unit: LogUnit) => {
    if (!endpoint) return defaultSink(unit);
    try {
      const url = new URL(endpoint);
      const data = {
        project: unit.project || 'default',
        session: unit.session || 'default',
        tagid: unit.tagId,
        description: unit.tagId,
        timestamp: unit.timestamp,
        payload: unit.payload,
      };
      const body = Buffer.from(JSON.stringify(data));
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;
      const req = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
          },
        },
        (res) => {
          // Drain response to free socket
          res.on('data', () => {});
        }
      );
      req.on('error', () => {
        // Silently ignore transport errors to avoid interfering with app flow
      });
      req.write(body);
      req.end();
    } catch {
      // Fall back silently if endpoint is invalid
    }
  };
}
