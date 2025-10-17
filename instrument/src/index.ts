// Public types for instrument options
export type Logger = (message?: any, ...optionalParams: any[]) => void;
export type ParamsSelector = (info: { names: string[]; args: any[]; thisArg: any; label: string }) => Array<string | number> | 'all' | 'none';

import type { LogUnit, MetricConfig, EvaluationResult, MethodologyType } from '@workspace/common';

export interface InstrumentOptions {
  logger?: Logger;
  label?: string;
  includeThis?: boolean;
  redact?: (key: string, value: unknown) => unknown;
  params?: Array<string | number> | ParamsSelector;
  logArgs?: boolean;
  logReturn?: boolean;
  // eslint-disable-next-line @typescript-eslint/ban-types
  return?: boolean;
  sink?: (payload: LogUnit) => void;
  /**
   * Provide a mock return value for the instrumented function/method.
   * When defined, the original implementation will NOT be invoked; instead the mock value (or the result of the factory) is returned.
   * - Static value: mockReturn: someValue
   * - Factory: mockReturn: ({ args, thisArg, label, original }) => any | Promise<any>
   * If the factory returns a Promise it is awaited transparently.
   * The mocked value is treated as the function result for logging (subject to logReturn option).
   */
  mockReturn?: any | ((ctx: { args: any[]; thisArg: any; label: string; original: Function }) => any | Promise<any>);
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

