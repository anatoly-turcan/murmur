import type { ContractView } from '@murmur/dev-protocol';
import type { ReactNode } from 'react';

import { displayName, kindMark } from './contract-kind.ts';

const TONES: Record<string, string> = {
  Q: 'bg-accent/15 text-accent',
  C: 'bg-warn/15 text-warn',
  E: 'bg-ok/15 text-ok',
  G: 'bg-line text-ink',
  R: 'bg-panel text-ink-muted',
};

export function KindBadge({ contract }: { contract: Pick<ContractView, 'kind' | 'hasReply'> }): ReactNode {
  const mark = kindMark(contract);

  return (
    <span
      className={`inline-block w-4 rounded text-center font-mono text-[10px] ${TONES[mark.letter]}`}
      title={mark.title}
      aria-label={`kind ${mark.title}`}
    >
      {mark.letter}
    </span>
  );
}

export function ContractName({ contract }: { contract: ContractView }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5">
      <KindBadge contract={contract} />
      <span className="font-mono" title={contract.name}>
        {displayName(contract)}
      </span>
    </span>
  );
}
