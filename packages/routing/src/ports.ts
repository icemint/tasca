// The engine consumes these ports; they are defined in @tasca/domain so the
// implementers (@tasca/db, adapters) can depend on the interface without
// importing the engine. Re-exported here so `@tasca/routing` surfaces them.
export type { ClaimOutcome, ClaimPort, LlmClassifierPort } from '@tasca/domain';
