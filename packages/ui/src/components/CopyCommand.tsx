import { useState, type ReactNode } from 'react';

export function CopyCommand({ command }: { command: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => setCopied(true));
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded border border-line bg-panel px-2 py-0.5 font-mono text-xs hover:border-accent"
      title="copy"
    >
      {command}
      <span className="ml-2 text-ink-muted">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}
