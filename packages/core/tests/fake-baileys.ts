import type {
  BaileysSocketOptions,
  ConnectionUpdateLike,
  MessagesUpsertLike,
  MinimalSocket,
} from "../src/index.js";

/**
 * Socket Baileys palsu untuk unit test BaileysGateway.
 * Meniru bentuk minimal WASocket: ev (on/removeAllListeners), ws.close,
 * user, sendMessage, sendPresenceUpdate — plus helper emit untuk
 * memicu event connection.update / messages.upsert secara deterministik.
 */
export class FakeBaileysSocket implements MinimalSocket {
  user?: { id: string; name?: string };
  wsClosed = false;
  listenersRemoved: string[] = [];
  sent: Array<{ jid: string; content: unknown }> = [];
  presence: Array<{ state: string; jid: string }> = [];
  lastOpts?: BaileysSocketOptions;

  private handlers = new Map<string, Array<(u: never) => void>>();

  ev = {
    on: (event: string, cb: (u: never) => void): void => {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    },
    removeAllListeners: (event?: string): void => {
      if (event) {
        this.listenersRemoved.push(event);
        this.handlers.delete(event);
      } else {
        this.listenersRemoved.push("*");
        this.handlers.clear();
      }
    },
  };

  ws = {
    close: (): void => {
      this.wsClosed = true;
    },
  };

  async sendMessage(
    jid: string,
    content: unknown,
  ): Promise<{ key: { id?: string | null } } | undefined> {
    this.sent.push({ jid, content });
    return { key: { id: `wamid-fake-${this.sent.length}` } };
  }

  async sendPresenceUpdate(state: string, jid: string): Promise<void> {
    this.presence.push({ state, jid });
  }

  emitConnectionUpdate(u: ConnectionUpdateLike): void {
    for (const cb of this.handlers.get("connection.update") ?? []) {
      cb(u as never);
    }
  }

  emitMessagesUpsert(u: MessagesUpsertLike): void {
    for (const cb of this.handlers.get("messages.upsert") ?? []) {
      cb(u as never);
    }
  }

  emitCredsUpdate(): void {
    for (const cb of this.handlers.get("creds.update") ?? []) {
      cb(undefined as never);
    }
  }
}
