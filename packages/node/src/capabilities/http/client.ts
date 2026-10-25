export interface Client {
  readonly peer: string;
  readonly ip: string;
}

export const LOCAL_CLIENT: Client = Object.freeze({ peer: '127.0.0.1', ip: '127.0.0.1' });

function firstForwarded(headers: Headers): string | undefined {
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();

  return first === '' ? undefined : first;
}

export function clientOf(headers: Headers, peer: string, trustProxy: boolean): Client {
  const forwarded = trustProxy ? firstForwarded(headers) : undefined;

  return { peer, ip: forwarded ?? peer };
}
