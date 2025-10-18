// Shared types extracted to standalone common module
// Refactored: args & vars now dictionaries for direct name-based access.
// Previously args: LogPayloadArgPair[] and vars: Array<{ name?: string; value: any; at: string }>.
// Migration: existing persisted units with array forms should be normalized when read (future enhancement).
export interface LogUnit {
  tagId: string;
  timestamp: number;
  session?: string;
  project?: string;
  payload: {
    // Function arguments keyed by parameter name (or arg{index} if unnamed)
    args?: Record<string, any>;
    thisArg?: any;
    // Logged variables keyed by provided name; each value holds the value and capture location/time string
    vars?: Record<string, { value: any; at: string }>;
    return?: any;
    error?: string;
    end?: number;
    durationMs?: number;
    // Indicates the unit values (args/vars/return) were overridden from a replay source
    replayed?: boolean;
  };
}

export type MethodologyType = 'DAG' | 'QAG' | 'string_match';

export interface MetricConfig {
  name: string;
  description?: string;
  longDescription?: string; // Additional detail beyond concise description
  methodology: MethodologyType;
  promptTemplate?: string;
  query: Record<string, string>;
  params?: Record<string, any>;
}

export interface EvaluationResult {
  metric: string;
  success: boolean;
  score?: number;
  details?: any;
  error?: string;
}

export interface LLM { generate(prompt: string): Promise<string> }
export interface MethodologyContext { metric: MetricConfig; inputs: Record<string, any>; llm: LLM }
export interface Methodology { name: MethodologyType; evaluate(ctx: MethodologyContext): Promise<EvaluationResult> }
