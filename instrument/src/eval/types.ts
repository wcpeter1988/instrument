export {
  LogUnit,
  MethodologyType,
  MetricConfig,
  EvaluationResult,
  LLM,
  MethodologyContext,
  Methodology,
} from '@workspace/common';
import type { LogUnit, MetricConfig, LLM, EvaluationResult } from '@workspace/common';
export type MetricEvaluation = (metric: MetricConfig, unit: LogUnit, llm: LLM) => Promise<EvaluationResult>;
