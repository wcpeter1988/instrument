import { AsyncLocalStorage } from 'async_hooks';
import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';

// Import types only to avoid runtime circular dependency with index.ts
import { InstrumentType } from './index';
import type { InstrumentOptions, ParamInstrumentationMap } from './index';
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
	// Optional replay data: map tagId -> array of units to replay
	replay?: Record<string, LogUnit[]>;
	// Internal counters to track position in replay arrays
	replayCursor?: Record<string, number>;
}

const sessionStore = new AsyncLocalStorage<InstrumentSession | undefined>();

// Start a session and automatically attach an in-memory collector. Returns the live units array.
// Backward compatibility: previous return was a disposer fn; now we return units[] while endInstrumentSession disposes.
export async function startInstrumentSession(project: string, sessionId: string, endpoint?: string, autoReplay: boolean = true): Promise<LogUnit[]> {
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

	// Attempt auto replay retrieval (now awaited) and preload existing units for this session
	if (autoReplay && sess.endpoint) {
		try {
			const url = new URL(sess.endpoint);
			const base = sess.endpoint.replace(/\/api\/data$/, '');
			const getUrl = `${base}/api/data?project=${encodeURIComponent(project)}&session=${encodeURIComponent(sessionId)}`;
			const isHttps = url.protocol === 'https:';
			const client = isHttps ? https : http;
			const data: string = await new Promise((resolve, reject) => {
				try {
					const req = client.get(getUrl, (res) => {
						let body = '';
						res.on('data', (chunk) => (body += chunk));
						res.on('end', () => resolve(body));
					});
					req.on('error', (err) => reject(err));
				} catch (e) {
					reject(e);
				}
			});
			try {
				const json = JSON.parse(data);
				if (json && json.data && typeof json.data === 'object') {
					const collected: LogUnit[] = [];
					const sessionsObj = json.data; // session -> tagId -> description -> items[]
					for (const sessKey of Object.keys(sessionsObj)) {
						const tagMap = sessionsObj[sessKey];
						for (const tagId of Object.keys(tagMap)) {
							const descMap = tagMap[tagId];
							for (const desc of Object.keys(descMap)) {
								for (const item of descMap[desc]) {
									if (!item || typeof item !== 'object') continue;
									collected.push({
										tagId: item.tagid || tagId,
										timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
										session: item.session,
										project: item.project,
										payload: { ...(item.payload || {}), preloaded: true },
									});
								}
							}
						}
					}
					if (collected.length) {
						setInstrumentSessionReplay(collected);
						for (const u of collected) sess.units!.push(u);
						console.log('[instrument][replay-load]', {
							project,
							sessionId,
							units: collected.length,
							tagIds: Object.keys(sess.replay || {})
						});
						console.log('[instrument][preloaded-existing]', { project, sessionId, preloaded: collected.length });
					}
				}
			} catch {
				// swallow parse errors
			}
		} catch (e) {
			console.error('[instrument][replay-load-fail]', { project, sessionId, error: (e as any)?.message || e });
		}
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

// Attach replay units to current session; units will override emitted unit fields (args, vars, return)
export function setInstrumentSessionReplay(units: LogUnit[]) {
	const sess = getInstrumentSession();
	if (!sess) throw new Error('setInstrumentSessionReplay must be called within an active instrument session');
	const byTag: Record<string, LogUnit[]> = {};
	for (const u of units) {
		// Primary key
		if (!byTag[u.tagId]) byTag[u.tagId] = [];
		byTag[u.tagId].push(u);
		// Provide alias: last segment after dot if different (e.g., Service.fetchContext -> fetchContext)
		const lastSeg = u.tagId.includes('.') ? u.tagId.split('.').pop()! : undefined;
		if (lastSeg && lastSeg !== u.tagId) {
			if (!byTag[lastSeg]) byTag[lastSeg] = [];
			byTag[lastSeg].push(u);
		}
	}
	sess.replay = byTag;
	sess.replayCursor = {};
}

export function clearInstrumentSessionReplay() {
	const sess = getInstrumentSession();
	if (!sess) return;
	delete sess.replay;
	delete sess.replayCursor;
}

interface ReplayResult { unit: LogUnit; overrideReturn?: any; overrideArgs?: any[] }
function applyReplayIfAvailable(payload: LogPayload, originalUnit: LogUnit, callArgs?: any[]): ReplayResult {
	const sess = getInstrumentSession();
	if (!sess?.replay) return { unit: originalUnit };
	let list = sess.replay[payload.label];
	if ((!list || list.length === 0) && payload.label.includes('.')) {
		const lastSeg = payload.label.split('.').pop()!;
		list = sess.replay[lastSeg];
	}
	if ((!list || list.length === 0) && payload.label.includes('@')) {
		const base = payload.label.split('@')[0];
		list = sess.replay[base] || sess.replay[base.split('.').pop()!];
	}
	if (!list || list.length === 0) return { unit: originalUnit };
	const cursor = sess.replayCursor![payload.label] || 0;
	const replayUnit = list[Math.min(cursor, list.length - 1)];
	sess.replayCursor![payload.label] = cursor + 1;
	const merged: LogUnit = {
		...originalUnit,
		payload: {
			...originalUnit.payload,
			args: replayUnit.payload.args ?? originalUnit.payload.args,
			vars: replayUnit.payload.vars ?? originalUnit.payload.vars,
			return: replayUnit.payload.return ?? originalUnit.payload.return,
			replayed: true,
		},
	};
	// If we have a replay return value, surface it so caller can override actual function return
	const overrideReturn = replayUnit.payload.return;
	// Provide overrideArgs (raw values) if replay supplied args and original call had arg names map
	let overrideArgs: any[] | undefined;
	if (replayUnit.payload.args && callArgs && callArgs.length) {
		// Attempt to rebuild ordered arg list from provided names in originalUnit.payload.args
		const argMap = replayUnit.payload.args as Record<string, any>;
		const ordered: any[] = [];
		for (let i = 0; i < callArgs.length; i++) {
			// Try by recorded param name or fallback to original arg
			const names = Object.keys(argMap);
			const byIndexName = names[i];
			ordered[i] = (byIndexName && argMap[byIndexName] !== undefined) ? argMap[byIndexName] : callArgs[i];
		}
		overrideArgs = ordered;
	}
	// eslint-disable-next-line no-console
	console.log('[instrument][replay-override]', {
		label: payload.label,
		cursor,
		replayCount: list.length,
		usedIndex: Math.min(cursor, list.length - 1),
		originalTimestamp: originalUnit.timestamp,
		replayTimestamp: replayUnit.timestamp,
	});
	return { unit: merged, overrideReturn, overrideArgs };
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
					res.on('data', () => { });
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
					// Pre-call argument override using replay args (does not advance cursor; consumption happens post-call)
					if (sess?.replay) {
						let list = sess.replay[label] || (label.includes('.') ? sess.replay[label.split('.').pop()!] : undefined);
						if ((!list || list.length === 0) && label.includes('@')) {
							const base = label.split('@')[0];
							list = sess.replay[base] || (base.includes('.') ? sess.replay[base.split('.').pop()!] : undefined);
						}
						if (list && list.length) {
							const cursor = sess.replayCursor?.[label] || 0; // peek without increment
							const replayUnit = list[Math.min(cursor, list.length - 1)];
							const replayArgsMap = replayUnit.payload?.args as Record<string, any> | undefined;
							if (replayArgsMap) {
								// Attempt name-based override first; fall back to index-based arg{index} keys.
								for (let i = 0; i < args.length; i++) {
									const nameKey = names[i];
									const indexKey = `arg${i}`;
									if (nameKey && replayArgsMap[nameKey] !== undefined) {
										args[i] = replayArgsMap[nameKey];
										continue;
									}
									if (replayArgsMap[indexKey] !== undefined) {
										args[i] = replayArgsMap[indexKey];
									}
								}
							}
						}
					}
					// New param instrumentation map handling
					const argMap: Record<string, any> = {};
					let paramMap: ParamInstrumentationMap = {};
					if (options.params) {
						if (typeof options.params === 'function') {
							try {
								paramMap = options.params({ names, args, thisArg: this, label }) || {};
							} catch {
								paramMap = {};
							}
						} else {
							paramMap = options.params as ParamInstrumentationMap;
						}
					}
					for (let i = 0; i < args.length; i++) {
						const key = names[i] || `arg${i}`;
						const mode = paramMap[key] ?? InstrumentType.None;
						if (mode === InstrumentType.Trace || mode === InstrumentType.TraceAndReplay) {
							argMap[key] = toJSONish(args[i], options.redact ?? defaultRedact);
						}
					}
					if (Object.keys(argMap).length) (payload as any).args = argMap;
					if (options.includeThis) (payload as any).thisArg = toJSONish(this, options.redact ?? defaultRedact);
					// mockReturn removed; always invoke original implementation. Use replay to override values.
					let result: any = original.apply(this, args);
					if (isPromiseLike(result)) {
						return (result as Promise<any>)
							.then((res) => {
								const returnMode = options.return ?? InstrumentType.None;
								if (returnMode === InstrumentType.Trace || returnMode === InstrumentType.TraceAndReplay) {
									(payload as any).return = toJSONish(res, options.redact ?? defaultRedact);
								}
								(payload as any).end = Date.now();
								(payload as any).durationMs = (payload as any).end - start;
								let unit: LogUnit = {
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
										// mocked flag removed
									},
								};
								const rr = applyReplayIfAvailable(payload, unit, args);
								unit = rr.unit;
								sink(unit);
								const shouldOverride = (options.return === InstrumentType.TraceAndReplay) && options.replayOverrideReturn && rr.overrideReturn !== undefined;
								return shouldOverride ? rr.overrideReturn : res;
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
						const returnMode = options.return ?? InstrumentType.None;
						if (returnMode === InstrumentType.Trace || returnMode === InstrumentType.TraceAndReplay) {
							(payload as any).return = toJSONish(result, options.redact ?? defaultRedact);
						}
						(payload as any).end = Date.now();
						(payload as any).durationMs = (payload as any).end - start;
						let unit: LogUnit = {
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
								// mocked flag removed
							},
						};
						const rr = applyReplayIfAvailable(payload, unit, args);
						unit = rr.unit;
						sink(unit);
						const shouldOverrideSync = (options.return === InstrumentType.TraceAndReplay) && options.replayOverrideReturn && rr.overrideReturn !== undefined;
						return shouldOverrideSync ? rr.overrideReturn : result;
					}
				} catch (err: any) {
					(payload as any).error = err?.stack || String(err);
					(payload as any).end = Date.now();
					(payload as any).durationMs = (payload as any).end - start;
					let unit: LogUnit = {
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
					const rr = applyReplayIfAvailable(payload, unit, args);
					unit = rr.unit;
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
	return function <T extends { new(...args: any[]): any }>(constructor: T) {
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
	const names = getParamNames(fn) || [];
	let paramMap: ParamInstrumentationMap = {};
	if (options.params) {
		if (typeof options.params === 'function') {
			try {
				paramMap = options.params({ names, args: allArgs, thisArg: undefined, label: options.label || (fn.name || 'anonymous') }) || {};
			} catch {
				paramMap = {};
			}
		} else {
			paramMap = options.params as ParamInstrumentationMap;
		}
	}
	const collected: any[] = [];
	for (let i = 0; i < allArgs.length; i++) {
		const key = names[i] || `arg${i}`;
		const mode = paramMap[key] ?? InstrumentType.None;
		if (mode === InstrumentType.Trace || mode === InstrumentType.TraceAndReplay) {
			collected.push(allArgs[i]);
		}
	}
	return safeStringify(collected, redact);
}

export function selectArgs(
	allArgs: any[],
	fn: Function,
	options: InstrumentOptions
) {
	const names = getParamNames(fn) || [];
	let paramMap: ParamInstrumentationMap = {};
	if (options.params) {
		if (typeof options.params === 'function') {
			try {
				paramMap = options.params({ names, args: allArgs, thisArg: undefined, label: options.label || (fn.name || 'anonymous') }) || {};
			} catch {
				paramMap = {};
			}
		} else {
			paramMap = options.params as ParamInstrumentationMap;
		}
	}
	const selected: any[] = [];
	for (let i = 0; i < allArgs.length; i++) {
		const key = names[i] || `arg${i}`;
		const mode = paramMap[key] ?? InstrumentType.None;
		if (mode === InstrumentType.Trace || mode === InstrumentType.TraceAndReplay) {
			selected.push(allArgs[i]);
		}
	}
	return selected;
}

export function logCall<T extends Function>(fn: T, options: InstrumentOptions = {}): T {
	const { logger = console.log, label = fn.name || 'anonymous', includeThis = false, redact = defaultRedact } = options;
	const wrapped: any = function (this: any, ...callArgs: any[]) {
		const callLabel = label;
		const parts: any[] = [];
		parts.push(`[call] ${callLabel}(` + pickArgs(callArgs, fn, options, redact) + ')');
		if (includeThis) {
			parts.push('this=' + safeStringify(this, redact));
		}
		logger(parts.join(' '));
		let result: any = (fn as any).apply(this, callArgs);
		const applyOverride = (res: any): any => {
			const returnMode = options.return ?? InstrumentType.None;
			if (returnMode === InstrumentType.Trace || returnMode === InstrumentType.TraceAndReplay) {
				logger(`[return] ${callLabel} -> ` + safeStringify(res, redact));
			}
			return res;
		};
		if (result && typeof (result as any).then === 'function') {
			return (result as any)
				.then((orig: any) => {
					const payload: LogPayload = { label: callLabel, start: Date.now(), project: getInstrumentSession()?.project, sessionId: getInstrumentSession()?.sessionId } as any;
					let unit: LogUnit = { tagId: callLabel, timestamp: payload.start, session: payload.sessionId, project: payload.project, payload: {} };
					const rr = applyReplayIfAvailable(payload, unit, callArgs);
					const shouldOverride = (options.return === InstrumentType.TraceAndReplay) && options.replayOverrideReturn && rr.overrideReturn !== undefined;
					const actual = shouldOverride ? rr.overrideReturn : orig;
					return applyOverride(actual);
				})
				.catch((err: any) => {
					logger(`[throw] ${callLabel} !! ` + (err?.stack || String(err)));
					throw err;
				});
		} else {
			const payload: LogPayload = { label: callLabel, start: Date.now(), project: getInstrumentSession()?.project, sessionId: getInstrumentSession()?.sessionId } as any;
			let unit: LogUnit = { tagId: callLabel, timestamp: payload.start, session: payload.sessionId, project: payload.project, payload: {} };
			const rr = applyReplayIfAvailable(payload, unit, callArgs);
			const shouldOverride = (options.return === InstrumentType.TraceAndReplay) && options.replayOverrideReturn && rr.overrideReturn !== undefined;
			const actual = shouldOverride ? rr.overrideReturn : result;
			return applyOverride(actual);
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
	return fallback;
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
		// Check replay for this label to override variable value
		const sess = getInstrumentSession();
		let replayValue: any = undefined;
		if (sess?.replay && payload.label) {
			let list = sess.replay[payload.label] || (payload.label.includes('.') ? sess.replay[payload.label.split('.').pop()!] : undefined);
			if ((!list || list.length === 0) && payload.label.includes('@')) {
				const base = payload.label.split('@')[0];
				list = sess.replay[base] || (base.includes('.') ? sess.replay[base.split('.').pop()!] : undefined);
			}
			if (list && list.length) {
				const cursor = sess.replayCursor?.[payload.label] || 0;
				const replayUnit = list[Math.min(cursor, list.length - 1)];
				const varsOverride = replayUnit.payload?.vars as any;
				if (varsOverride && varsOverride[varName]?.value !== undefined) {
					replayValue = varsOverride[varName].value;
				}
			}
		}
		const finalVal = replayValue !== undefined ? replayValue : value;
		payload.vars[varName] = { value: toJSONish(finalVal, opt.redact ?? defaultRedact), at };
		return finalVal;
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
				let result: any = fn.apply(this, args);
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
