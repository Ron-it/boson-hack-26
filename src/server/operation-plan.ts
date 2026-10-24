import type { PhoneRequest, TaskStatus } from './task.ts';
import type { OutcomeEvidence } from '../mobile/workflows.ts';

export type OperationEvidence = OutcomeEvidence
  | { kind: 'native_media'; requestedPercent: number; observedIndex: number; minIndex: number; maxIndex: number }
  | { kind: 'display_settings'; brightness?: number | undefined; nightLight?: boolean | undefined; observedRawValue?: number }
  | { kind: 'message_sent'; packageName: string; recipient: string; message: string }
  | { kind: 'intent_handoff'; operation: 'create_timer' | 'create_alarm'; handlerPackage: string; verified: false };

export type OperationScope = { revision: number; signal: AbortSignal; instruction: string };
export type OperationProgress = {
  id: string; label: string; effect: 'setting' | 'intent' | 'ui';
  state: 'pending' | Exclude<TaskStatus['state'], 'working' | 'paused'>;
  detail?: string; evidence?: OperationEvidence;
};
export type PlannedOperation = OperationProgress & {
  key: string;
  recovery: 'inspect' | 'manual';
  execute(scope: OperationScope): Promise<void>;
  check?: (scope: OperationScope, evidence?: OperationEvidence) => Promise<OperationEvidence | false>;
};

/** A small common contract. Typed arguments stay captured with their executor and result check. */
export function planOperation<Args>(request: PhoneRequest, capability: {
  id: string; label: string; effect: OperationProgress['effect']; recovery?: PlannedOperation['recovery'];
  arguments(request: PhoneRequest): Args | undefined;
  execute(args: Args, scope: OperationScope): Promise<void>;
  check?: (args: Args, scope: OperationScope, evidence?: OperationEvidence) => Promise<OperationEvidence | false>;
}): PlannedOperation | undefined {
  const args = capability.arguments(request);
  if (args === undefined) return undefined;
  const verify = capability.check;
  return {
    id: capability.id, label: capability.label, effect: capability.effect, state: 'pending',
    key: JSON.stringify([capability.id, args]), recovery: capability.recovery ?? 'inspect',
    execute: scope => capability.execute(args, scope),
    ...(verify && { check: (scope, evidence) => verify(args, scope, evidence) }),
  };
}
