import type { ContractView, EmitResponse } from '@murmur/dev-protocol';

import { api } from './client.ts';
import { sampleFromSchema } from './sample.ts';

export function fixtureFor(contract: ContractView): unknown {
  return sampleFromSchema(contract.schema.payload);
}

export function emitFixture(
  contract: ContractView,
  payload: unknown = fixtureFor(contract),
): Promise<EmitResponse> {
  return api.emit({ contract: contract.name, payload, mode: contract.hasReply ? 'request' : 'emit' });
}
