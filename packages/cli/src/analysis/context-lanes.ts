import { unique, type LaneName, type PartialLanes } from './lanes.ts';

export type LaneTexts = Partial<Record<LaneName, string[]>>;

const LINE = /^(?:[-*]\s+)?\**(Needs|Listens|Handles|Emits|Requests|Serves)\**:\**[ \t]*(.*)$/;
const LANE_HEADING = /^#{1,6}\s+(Needs|Listens|Handles|Emits|Requests|Serves)\s*$/;
const HEADING = /^#{1,6}\s/;
const BULLET = /^[-*]\s+/;
const NOT_A_LANE = /^(?:[-*]\s+)?\**Storage\**:/;
const EMPTY = new Set(['', '—', '-', 'none']);

function laneOf(keyword: string | undefined): LaneName | null {
  if (keyword === undefined) {
    return null;
  }

  return keyword === 'Handles' ? 'listens' : (keyword.toLowerCase() as LaneName);
}

function lineText(line: string, section: LaneName | null): [LaneName, string] | null {
  if (NOT_A_LANE.test(line)) {
    return null;
  }

  const match = LINE.exec(line);
  if (match !== null) {
    return [laneOf(match[1]) as LaneName, match[2] as string];
  }

  if (section === null || line === '') {
    return null;
  }

  return [section, line.replace(BULLET, '')];
}

export function laneTexts(markdown: string | null): LaneTexts {
  const texts: LaneTexts = {};
  let fenced = false;
  let section: LaneName | null = null;

  for (const raw of (markdown ?? '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }

    if (fenced) {
      continue;
    }

    if (HEADING.test(line)) {
      section = laneOf(LANE_HEADING.exec(line)?.[1]);
      continue;
    }

    const found = lineText(line, section);
    if (found !== null) {
      texts[found[0]] = [...(texts[found[0]] ?? []), found[1]];
    }
  }

  return texts;
}

function items(value: string, lane: LaneName): string[] {
  return value
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((item) => item.replaceAll('`', '').trim())
    .map((item) => (lane === 'serves' ? item : (item.split(/\s+/)[0] ?? '')).replace(/\.$/, ''))
    .filter((item) => !EMPTY.has(item.toLowerCase()));
}

export function contextLanes(markdown: string | null): PartialLanes {
  const texts = laneTexts(markdown);
  const lanes: Partial<Record<LaneName, string[]>> = {};

  for (const [lane, values] of Object.entries(texts) as [LaneName, string[]][]) {
    lanes[lane] = unique(values.flatMap((value) => items(value, lane)));
  }

  return lanes;
}
