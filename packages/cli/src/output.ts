import { styleText } from 'node:util';

type Style = Parameters<typeof styleText>[0];

export interface Output {
  readonly json: boolean;
  readonly quiet: boolean;
  print(text: string): void;
  info(text: string): void;
  warn(text: string): void;
  emit(value: { readonly kind: string } & Record<string, unknown>): void;
  stream(value: { readonly frame: string }): void;
  style(format: Style, text: string): string;
}

export interface OutputOptions {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly color: boolean;
}

function colorEnabled(options: OutputOptions): boolean {
  return options.color && process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true;
}

export function createOutput(options: OutputOptions): Output {
  const color = colorEnabled(options);

  return {
    json: options.json,
    quiet: options.quiet,
    print: (text) => {
      if (!options.json && !options.quiet) {
        process.stdout.write(`${text}\n`);
      }
    },
    info: (text) => {
      if (!options.quiet) {
        process.stderr.write(`${text}\n`);
      }
    },
    warn: (text) => process.stderr.write(`${text}\n`),
    emit: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    stream: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    style: (format, text) => (color ? styleText(format, text, { validateStream: false }) : text),
  };
}

export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
