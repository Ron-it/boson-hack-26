import { z } from 'zod';

/** Text is bound to a purpose and its provenance, rather than invented by the navigation model. */
export const inputValueSchema = z.object({
  field: z.string().min(1).max(80), text: z.string().min(1).max(2000),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('request') }),
    z.object({ kind: z.literal('screen'), packageName: z.string(), resourceId: z.string().min(1), text: z.string() }),
  ]),
});

/** Only explicit outcome kinds with an app-owned evidence check can complete a generic request. */
export const workflowRequestSchema = z.object({
  values: z.array(inputValueSchema).max(16).optional(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('search_results'), query: z.string().min(1).max(2000) }),
    z.object({ kind: z.literal('content_opened'), name: z.string().min(1).max(240) }),
  ]).optional(),
});
export type WorkflowRequest = z.infer<typeof workflowRequestSchema>;
export type InputValue = z.infer<typeof inputValueSchema>;

/** A selection the operator actually dispatched, used with a fresh viewer observation, never alone. */
export type ContentSelection = { packageName: string; name: string; viewer: 'image' };
export type OutcomeEvidence =
  | { kind: 'search_results'; packageName: string; query: string; matches: string[]; detail: string }
  | { kind: 'content_opened'; packageName: string; selection: ContentSelection; resourceId: string; detail: string };
