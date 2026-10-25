import type { ReactNode } from 'react';

import { Kbd } from '../components/Kbd.tsx';
import { BINDINGS } from '../keys/bindings.ts';

export function ShortcutSheet({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20" onClick={onClose}>
      <div
        className="w-[520px] rounded border border-line bg-paper p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="shortcuts"
      >
        <h2 className="mb-2 font-semibold">Shortcuts</h2>
        <table className="w-full text-xs">
          <tbody>
            {BINDINGS.map((b) => (
              <tr key={`${b.scope}:${b.keys}`}>
                <td className="py-0.5 pr-3 text-ink-muted">{b.scope}</td>
                <td className="pr-3">
                  <Kbd>{b.keys}</Kbd>
                </td>
                <td>{b.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
