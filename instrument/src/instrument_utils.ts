import { AsyncLocalStorage } from 'async_hooks';
import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';

// Import types only to avoid runtime circular dependency with index.ts
import type { InstrumentOptions } from './index';
import type { LogUnit } from '@workspace/common';

// Helper: safe JSON stringify with optional redaction
export const defaultRedact = (_key: string, value: unknown) => value;

export function safeStringify(value: unknown, redact: InstrumentOptions['redact']) {
	try {
		return JSON.stringify(value, (k, v) => redact?.(k, v) ?? v);
	} catch {
		return '[unserializable return]';
	}
}

export function toJSONish(value: unknown, redact: InstrumentOptions['redact']) {
	const s = safeStringify(value, redact);
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

export function formatArgs(args: IArguments | any[], redact: InstrumentOptions['redact']) {
	try {
		return JSON.stringify(Array.from(args), (k, v) => redact?.(k, v) ?? v);
	} catch {
		return '[unserializable arguments]';
	}
}

// Best-effort parameter name extraction from function source string
export function getParamNames(fn: Function): string[] | null {
	try {
		const src = Function.prototype.toString.call(fn);
		const m = src.match(/^[^(]*\(([^)]*)\)/);
		if (!m) return null;
		const inside = m[1].trim();
		if (!inside) return [];
		return inside
			.split(',')
			.map((s) => s.trim())
			.map((s) => s.replace(/=.*/, '').trim())
			.map((s) => s.replace(/^\.{3}/, ''))
			.map((s) => s);
	} catch {
		return null;
	}
}

function isPromiseLike(v: any) {
	return v && typeof v.then === 'function';
}

// LogUnit types sourced from common module

// Internal aggregate used during call execution
export interface LogPayload {
	label: string;
	args?: Record<string, any>; // keyed by param name or arg{index}
	thisArg?: any;
	vars?: Record<string, { value: any; at: string }>; // keyed by variable name
	return?: any;
	error?: string;
	project?: string;
	sessionId?: string;
	start: number;
	end?: number;
	durationMs?: number;
}

type CallContext = { payload: LogPayload; options: InstrumentOptions };
export const callContext = new AsyncLocalStorage<CallContext>();

const defaultSink = (unit: LogUnit) => {
	// eslint-disable-next-line no-console
	console.log('[unit]', JSON.stringify(unit));
};

// Session context for correlating instrumentation across calls
export interface InstrumentSession {
	project: string;
	sessionId: string;
	endpoint?: string; // optional datalake endpoint to POST log units
  // Optional in-memory sink/collection for current session
  sink?: (unit: LogUnit) => void;
  units?: LogUnit[];
}

const sessionStore = new AsyncLocalStorage<InstrumentSession | undefined>();

// Start a session and automatically attach an in-memory collector. Returns the live units array.
// Backward compatibility: previous return was a disposer fn; now we return units[] while endInstrumentSession disposes.
export function startInstrumentSession(project: string, sessionId: string, endpoint?: string): LogUnit[] {
	// Normalize endpoint: allow passing base service URL (http://host:port) or full /api/data path.
	let ep = endpoint;
	if (ep) {
		// If user passed base like http://localhost:3300, append /api/data
		if (!/\/api\/data$/.test(ep)) {
			// avoid double slashes
			ep = ep.replace(/\/$/, '') + '/api/data';
		}
	}
	sessionStore.enterWith({ project, sessionId, endpoint: ep });
	// auto attach collector (forward to endpoint by default)
	const sess = getInstrumentSession();
	if (!sess) throw new Error('Failed to initialize instrument session');
	if (!sess.units) {
		const units: LogUnit[] = [];
		const epSink = sess.endpoint ? endpointSink(sess.endpoint) : undefined;
		sess.sink = (u: LogUnit) => {
			units.push(u);
			// Always forward to endpoint if provided (matches previous attachSessionCollector(true) default)
			epSink?.(u);
		};
		sess.units = units;
	}
	return sess.units!;
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

// Create a sink that posts LogUnits to a datalake-compatible endpoint.
export function endpointSink(endpoint: string | undefined) {
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
					// consume to free socket
					res.on('data', () => {});
					if (res.statusCode && res.statusCode >= 400) {
						// eslint-disable-next-line no-console
						console.warn('[instrument-upload-fail]', res.statusCode, endpoint);
					}
				}
			);
			req.on('error', (err) => {
				// eslint-disable-next-line no-console
				console.warn('[instrument-upload-error]', endpoint, (err as any)?.message || err);
			});
			req.write(body);
			req.end();
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn('[instrument-endpoint-invalid]', endpoint, (err as any)?.message || err);
		}
	};
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
			const sink = options.sink ?? sess?.sink ?? (sess?.endpoint ? endpointSink(sess.endpoint) : defaultSink);
			const payload: LogPayload = { label, start, project: sess?.project, sessionId: sess?.sessionId };
			const ctx: CallContext = { payload, options } as any;
			return callContext.run(ctx, () => {
				try {
					const names = getParamNames(original) || [];
					const argMap: Record<string, any> = {};
					if (options.logArgs !== false) {
						let selectedList: Array<string | number> | 'all' | 'none' | undefined = undefined;
						if (typeof options.params === 'function') {
							try {
								selectedList = options.params({ names, args, thisArg: this, label });
							} catch {
								selectedList = 'none';
							}
						} else if (Array.isArray(options.params)) {
							selectedList = options.params as Array<string | number>;
						} else if (options.params === 'all' || options.params === 'none') {
							selectedList = options.params as 'all' | 'none';
						} else {
							selectedList = 'none';
						}
						if (selectedList && selectedList !== 'all' && selectedList !== 'none' && selectedList.length > 0) {
							for (const p of selectedList) {
								if (typeof p === 'number') {
									const idx = p;
									if (idx >= 0 && idx < args.length) {
										const key = names[idx] || `arg${idx}`;
										argMap[key] = toJSONish(args[idx], options.redact ?? defaultRedact);
									}
								} else if (typeof p === 'string') {
									const idx = names.indexOf(p);
									if (idx >= 0 && idx < args.length) {
										argMap[p] = toJSONish(args[idx], options.redact ?? defaultRedact);
									}
								}
							}
						} else if (selectedList === 'all') {
							for (let i = 0; i < args.length; i++) {
								const key = names[i] || `arg${i}`;
								argMap[key] = toJSONish(args[i], options.redact ?? defaultRedact);
							}
						}
						}
						if (Object.keys(argMap).length) (payload as any).args = argMap;
					if (options.includeThis) (payload as any).thisArg = toJSONish(this, options.redact ?? defaultRedact);
					const result = original.apply(this, args);
					if (isPromiseLike(result)) {
						return (result as Promise<any>)
							.then((res) => {
								const shouldLogReturn = (options.logReturn ?? (options as any).return ?? false) === true;
								if (shouldLogReturn) (payload as any).return = toJSONish(res, options.redact ?? defaultRedact);
								(payload as any).end = Date.now();
								(payload as any).durationMs = (payload as any).end - start;
								const unit: LogUnit = {
									tagId: (payload as any).label,
									timestamp: (payload as any).start,
									session: (payload as any).sessionId,
									project: (payload as any).project,
									payload: {
										args: (payload as any).args,
										thisArg: (payload as any).thisArg,
										vars: (payload as any).vars,
										return: (payload as any).return,
										error: (payload as any).error,
										end: (payload as any).end,
										durationMs: (payload as any).durationMs,
									},
								};
								sink(unit);
								return res;
							})
							.catch((err) => {
								(payload as any).error = (err as any)?.stack || String(err);
								(payload as any).end = Date.now();
								(payload as any).durationMs = (payload as any).end - start;
								const unit: LogUnit = {
									tagId: (payload as any).label,
									timestamp: (payload as any).start,
									session: (payload as any).sessionId,
									project: (payload as any).project,
									payload: {
										args: (payload as any).args,
										thisArg: (payload as any).thisArg,
										vars: (payload as any).vars,
										return: (payload as any).return,
										error: (payload as any).error,
										end: (payload as any).end,
										durationMs: (payload as any).durationMs,
									},
								};
								sink(unit);
								throw err;
							});
					} else {
						const shouldLogReturn = (options.logReturn ?? (options as any).return ?? false) === true;
						if (shouldLogReturn) (payload as any).return = toJSONish(result, options.redact ?? defaultRedact);
						(payload as any).end = Date.now();
						(payload as any).durationMs = (payload as any).end - start;
						const unit: LogUnit = {
							tagId: (payload as any).label,
							timestamp: (payload as any).start,
							session: (payload as any).sessionId,
							project: (payload as any).project,
							payload: {
									args: (payload as any).args,
								thisArg: (payload as any).thisArg,
								vars: (payload as any).vars,
								return: (payload as any).return,
								error: (payload as any).error,
								end: (payload as any).end,
								durationMs: (payload as any).durationMs,
							},
						};
						sink(unit);
						return result;
					}
				} catch (err: any) {
					(payload as any).error = err?.stack || String(err);
					(payload as any).end = Date.now();
					(payload as any).durationMs = (payload as any).end - start;
					const unit: LogUnit = {
						tagId: (payload as any).label,
						timestamp: (payload as any).start,
						session: (payload as any).sessionId,
						project: (payload as any).project,
						payload: {
								args: (payload as any).args,
							thisArg: (payload as any).thisArg,
							vars: (payload as any).vars,
							return: (payload as any).return,
							error: (payload as any).error,
							end: (payload as any).end,
							durationMs: (payload as any).durationMs,
						},
					};
					sink(unit);
					throw err;
				}
			});
		};
	};
}

// Attach a per-session in-memory collector sink. Returns the live units array.
// Deprecated: attachSessionCollector no longer needed since startInstrumentSession returns units.
export function attachSessionCollector(_forwardToEndpoint = true): LogUnit[] {
	const sess = getInstrumentSession();
	if (!sess) throw new Error('attachSessionCollector must be called within an active instrument session');
	return sess.units || [];
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
			}
		}
		return constructor;
	};
}

// Argument selection utilities used by logCall
export function pickArgs(
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

export function selectArgs(
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
		const result = (fn as any).apply(this, args);
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
	Object.defineProperty(wrapped, 'name', { value: (fn as any).name, configurable: true });
	return wrapped as unknown as T;
}

// Inline-friendly wrapper that auto-labels with callsite location if label not provided
export function deriveCallsiteLabel(fallback: string) {
	const err = new Error();
	const stack = (err.stack || '').split('\n').slice(2); // skip Error line + current function
	const frame = stack.find((l) => !/instrument[\\/].*index\.ts/.test(l) && !/node_modules/.test(l) && !/internal\//.test(l));
	if (!frame) return fallback;
	const m = frame.match(/\(?([^()]+):(\d+):(\d+)\)?/);
	if (!m) return fallback;
	const [, file, line, col] = m;
	return `${fallback}@${file}:${line}:${col}`;
}

export function getCallsite() {
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

export function tryInferVarNameFromSource(cs: { file: string; line: number; col: number }): string | undefined {
	try {
		const text = fs.readFileSync(cs.file, 'utf8');
		const lines = text.split(/\r?\n/);
		const lineStr = lines[cs.line - 1] || '';
		let startIdx = cs.col - 1;
		startIdx = Math.max(0, Math.min(startIdx, lineStr.length - 1));
		let lp = lineStr.lastIndexOf('(', startIdx);
		if (lp === -1) return undefined;
		const rest = lineStr.slice(lp + 1);
		const rpLocal = rest.indexOf(')');
		const argStr = (rpLocal >= 0 ? rest.slice(0, rpLocal) : rest).trim();
		const firstArg = argStr.split(',')[0]?.trim() || '';
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
export function logVar<T>(value: T, name?: string, options: InstrumentOptions = {}): T {
	const store = callContext.getStore();
	if (store) {
		const { payload, options: opt } = store as any;
		// Ensure dictionary initialization
		if (!payload.vars) payload.vars = {};
		const cs = getCallsite();
		const rel = cs ? path.relative(process.cwd(), cs.file).split(path.sep).join('/') : 'unknown';
		const inferred = (!name && cs) ? tryInferVarNameFromSource(cs) : undefined;
		const varName = name || inferred || 'var';
		const at = `${varName}@${rel}${cs ? `:${cs.line}:${cs.col}` : ''}`;
		payload.vars[varName] = { value: toJSONish(value, opt.redact ?? defaultRedact), at };
		return value;
	}
	const { logger = console.log, redact = defaultRedact } = options;
	const base = options.label ?? (name || 'var');
	const label = deriveCallsiteLabel(base);
	const body = name ? `${name}=` + safeStringify(value, redact) : safeStringify(value, redact);
	logger(`[var] ${label} ` + body);
	return value;
}

export function logVars<T extends Record<string, any>>(vars: T, options: InstrumentOptions = {}): T {
	for (const [k, v] of Object.entries(vars)) {
		logVar(v, k, options);
	}
	return vars;
}

// Proxy-based instrumentation for functions, objects, and classes
type AnyFn = (...args: any[]) => any;

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
		try {
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

	return instrumentObject(target as object) as T;
}
