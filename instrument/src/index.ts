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

