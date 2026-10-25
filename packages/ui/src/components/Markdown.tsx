import MarkdownIt from 'markdown-it';
import { useMemo, type ReactNode } from 'react';

const md = new MarkdownIt({ html: false, linkify: true });

export function stripFrontmatter(source: string): string {
  return source.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

export function Markdown({ source }: { source: string }): ReactNode {
  const html = useMemo(() => md.render(stripFrontmatter(source)), [source]);

  return (
    <div
      className="prose-murmur max-w-3xl leading-6 [&_code]:font-mono [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:my-2 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-panel [&_pre]:p-2"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
