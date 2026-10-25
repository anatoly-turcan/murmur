import { callersSharing, type LogLine } from '@murmur/dev-protocol';
import { Fragment, type ReactNode } from 'react';

import {
  toPercent,
  type Waterfall as WaterfallModel,
  type WaterfallBar,
  type WaterfallRow,
} from './waterfall-math.ts';
import { dedupeLines, guideLines, hiddenRows } from './waterfall-view.ts';

const ROW_H = 26;
const STEP = 10;
const BAR_TONES = new Map<string, string>([
  ['retried', 'bg-warn'],
  ['inflight', 'bg-accent/50'],
]);

function BarView({ bar, total, final }: { bar: WaterfallBar; total: number; final: boolean }) {
  const failed = bar.outcome === 'failed' || bar.outcome === 'deadLettered';
  const tone = failed ? 'bg-fail' : (BAR_TONES.get(bar.outcome) ?? 'bg-accent');
  const height = final ? 'top-1 h-3' : 'top-2 h-1';

  return (
    <div
      className={`absolute rounded-sm ${tone} ${height}`}
      style={{
        left: `${toPercent(bar.start, total)}%`,
        width: `max(2px, ${toPercent(bar.end - bar.start, total)}%)`,
      }}
      title={`${bar.piece} attempt ${bar.attempt} · ${bar.end - bar.start}ms · ${bar.outcome}${bar.error ? ` · ${bar.error}` : ''}`}
    />
  );
}

function ReplyBar({ reply, total }: { reply: NonNullable<WaterfallRow['reply']>; total: number }) {
  const border = reply.timedOut ? 'border-fail' : 'border-ink-muted';
  const note = reply.timedOut ? ' (timed out)' : '';

  return (
    <div
      className={`absolute bottom-0.5 h-1.5 border-x border-b ${border}`}
      style={{
        left: `${toPercent(reply.start, total)}%`,
        width: `${toPercent(reply.end - reply.start, total)}%`,
      }}
      title={`reply ${reply.end - reply.start}ms${note}`}
    />
  );
}

function Lane({ row, total }: { row: WaterfallRow; total: number }) {
  const last = row.bars.at(-1);
  const errored = row.bars.findLast((b) => b.error);

  return (
    <div className="relative h-full">
      {row.gaps.map((g) => (
        <div
          key={g.start}
          className="absolute top-2.5 border-t border-dotted border-warn"
          style={{ left: `${toPercent(g.start, total)}%`, width: `${toPercent(g.end - g.start, total)}%` }}
          title={`backoff ${g.end - g.start}ms`}
        />
      ))}
      {row.bars.map((bar) => (
        <BarView key={bar.attempt} bar={bar} total={total} final={bar === last} />
      ))}
      {row.reply ? <ReplyBar reply={row.reply} total={total} /> : null}
      {row.reply?.rejected === undefined ? null : (
        <span
          className="absolute top-0 rounded bg-warn/15 px-1 text-[11px] text-warn"
          style={{ left: `calc(${toPercent(row.reply.end, total)}% + 6px)` }}
        >
          rejected {row.reply.rejected}
        </span>
      )}
      {row.failed && errored?.error ? (
        <span
          className="absolute top-0 text-[11px] text-fail"
          style={{ left: `calc(${toPercent(errored.end, total)}% + 6px)` }}
        >
          {errored.error}
        </span>
      ) : null}
    </div>
  );
}

function OriginBadge({ row }: { row: WaterfallRow }) {
  if (row.origin === undefined) {
    return null;
  }

  return (
    <span className="mr-1 rounded border border-line px-1 text-[10px] text-ink-muted" aria-label="trace root">
      {row.origin.kind}
    </span>
  );
}

function DedupeBadge({ row }: { row: WaterfallRow }) {
  if (row.deduped === undefined) {
    return null;
  }

  const { by } = row.deduped;

  return (
    <span
      className="ml-1 rounded bg-accent/15 px-1 text-[10px] text-accent"
      title={`deduplicated for ${by.join(', ')}`}
    >
      ×{callersSharing(row.deduped)}
    </span>
  );
}

export interface WaterfallProps {
  model: WaterfallModel;
  collapsed: ReadonlySet<string>;
  selected: number | null;
  logs: LogLine[] | null;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
}

export function Waterfall({
  model,
  collapsed,
  selected,
  logs,
  onSelect,
  onHover,
}: WaterfallProps): ReactNode {
  const hidden = hiddenRows(model.rows, collapsed);
  const visible = model.rows.map((_, i) => i).filter((i) => !hidden.has(i));
  const gutter = (Math.max(0, ...model.rows.map((r) => r.causalDepth)) + 1) * STEP;
  const lines = guideLines(model.rows, visible, ROW_H, STEP);
  const dashed = dedupeLines(model.rows, visible, ROW_H, gutter - 3);
  const logsFor = (row: WaterfallRow) =>
    (logs ?? []).filter((l) => l.eventId === row.nodeId && (row.piece === null || l.piece === row.piece));

  return (
    <div className="relative" onMouseLeave={() => onHover(null)}>
      {logs === null ? (
        <svg
          className="pointer-events-none absolute top-0 left-0"
          width={gutter}
          height={visible.length * ROW_H}
          aria-hidden
        >
          {lines.map((l, i) => (
            <line key={i} {...l} className="stroke-line" />
          ))}
          {dashed.map((l, i) => (
            <line key={`dedupe-${i}`} {...l} className="stroke-accent" strokeDasharray="3 2" data-dedupe />
          ))}
        </svg>
      ) : null}
      {visible.map((index) => {
        const row = model.rows[index];
        if (row === undefined) {
          return null;
        }

        return (
          <Fragment key={`${row.nodeId}:${row.piece ?? ''}`}>
            <div
              className={`grid cursor-pointer items-center text-xs ${selected === index ? 'bg-accent/10' : 'hover:bg-panel'}`}
              style={{ height: ROW_H, gridTemplateColumns: `${gutter}px 300px 1fr` }}
              onClick={() => onSelect(index)}
              onMouseEnter={() => onHover(index)}
            >
              <span />
              <span className="truncate font-mono" style={{ paddingLeft: row.indent * 14 }}>
                {collapsed.has(row.nodeId) ? '▸ ' : ''}
                <OriginBadge row={row} />
                <span className={row.failed ? 'text-fail' : ''}>{row.name}</span>
                <DedupeBadge row={row} />
                <span className="text-ink-muted"> → {row.piece ?? 'unrouted'}</span>
              </span>
              <Lane row={row} total={model.totalMs} />
            </div>
            {logs
              ? logsFor(row).map((l, i) => (
                  <div
                    key={i}
                    className="truncate pl-8 font-mono text-[11px] text-ink-muted"
                    style={{ paddingLeft: gutter + 300 }}
                  >
                    {l.level} {l.msg}
                  </div>
                ))
              : null}
          </Fragment>
        );
      })}
    </div>
  );
}
