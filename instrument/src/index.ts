// Public types for instrument options
export type Logger = (message?: any, ...optionalParams: any[]) => void;
export type ParamsSelector = (info: { names: string[]; args: any[]; thisArg: any; label: string }) => Array<string | number> | 'all' | 'none';

import type { LogUnit, MetricConfig, EvaluationResult, MethodologyType } from '@workspace/common';

// New enum describing instrumentation behavior per parameter/return value
export enum InstrumentType {
  None = 'None',            // Do not log or replay
  Trace = 'Trace',          // Log value but do not allow replay override
  TraceAndReplay = 'TraceAndReplay', // Log and allow session replay to override
}

export type ParamInstrumentationMap = Record<string, InstrumentType>;
export type ParamsSelectorV2 = (info: { names: string[]; args: any[]; thisArg: any; label: string }) => ParamInstrumentationMap;

export interface InstrumentOptions {
  logger?: Logger;
  label?: string;
  includeThis?: boolean;
  redact?: (key: string, value: unknown) => unknown;
  // New params: map of paramName -> InstrumentType or selector returning that map.
  // If a name missing from map defaults to InstrumentType.None.
  params?: ParamInstrumentationMap | ParamsSelectorV2;
  // Return instrumentation: defaults to InstrumentType.None
  return?: InstrumentType;
  sink?: (payload: LogUnit) => void;
  // If true, and return InstrumentType.TraceAndReplay, replay override is applied to actual return value.
  replayOverrideReturn?: boolean;
}

// Re-export all public instrumentation APIs from utils
export {
  LogMethod,
  LogAll,
  startInstrumentSession,
  runInInstrumentSession,
  endInstrumentSession,
  getInstrumentSession,
  logCall,
  logInline,
  logVar,
  logVars,
  instrument,
  attachSessionCollector,
  setInstrumentSessionReplay,
  clearInstrumentSessionReplay,
} from './instrument_utils';
export type { InstrumentSession } from './instrument_utils';
export * from '@workspace/common';
export * as CommonQuery from '@workspace/common';

// Shorthand aliases preserved for compatibility
import { LogMethod, LogAll, logCall, logInline, logVar, logVars } from './instrument_utils';
export const Log = LogMethod;
export const InstrumentMethod = LogMethod;
export const InstrumentAll = LogAll;
export const InstrumentInline = logInline;
export const InstrumentVar = logVar;
export const InstrumentVars = logVars;
export const InstrumentCall = logCall;

// Evaluation framework exports
export * as Eval from './eval/evaluator';
export * as EvalTypes from './eval/types';
export * as EvalQuery from './eval/query';
export { autoGenerateMetrics, autoGenerate } from './eval/autogen';
export { EvalClient } from './eval/evaluator';

