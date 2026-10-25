export enum Channel {
  Email,
}

function logged(target: unknown): void {
  void target;
}

@logged
export class Mailer {
  constructor(private readonly url: string) {}

  async send(channel: Channel, id: string): Promise<void> {
    // retry later
    await fetch(this.url, { method: 'POST', body: `${channel}:${id}` });
  }
}
