/**
 * Bridge supervisor for authenticated agent communication.
 */

import { randomUUID } from "node:crypto";
import { createServer, createConnection, type Socket } from "node:net";

export interface BridgeSupervisorOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly runId: string;
  readonly agentId: string;
}

export class BridgeSupervisorError extends Error {
  constructor(public message: string) {
    super(message);
    this.name = "BridgeSupervisorError";
  }
}

export class BridgeSupervisor {
  readonly #options: BridgeSupervisorOptions;
  readonly #pendingPromises: Map<
    string,
    Promise<{ resolve?: (data: unknown) => void | Promise<void> } | never>
  > = new Map();
  readonly #servers: Set<Socket> = new Set();

  constructor(options: BridgeSupervisorOptions) {
    this.#options = options;
  }

  start(): BridgeSupervisor {
    return this;
  }

  async hello(socket: Socket): Promise<unknown> {
    socket.write(
      JSON.stringify({
        type: "auth.hello",
        payload: { runId: this.#options.runId, agentId: this.#options.agentId },
      }),
    );
    return new Promise((resolve) => {
      this.#pendingPromises.set("hello", Promise.resolve({ resolve }));
      console.log(
        `[${Date.now().toString().slice(-3)}ms] Hello sent from ${this.#options.runId}`,
      );
    });
  }

  close(): void {
    for (const server of this.#servers) {
      server.destroy();
    }
    this.#servers.clear();
  }

  #closeServer(socket: Socket): void {
    this.#activeSessions.delete(socket);
    this.#servers.delete(socket);
    console.log(
      `[${Date.now().toString().slice(-3)}ms] Server closed: ${socket.uid}`,
    );
  }
}

const Supervisor = class {
  readonly #options: BridgeSupervisorOptions = {
    runId: "test",
    agentId: "test",
    token: "",
    socketPath: "",
  };

  #activeSessions = new Set();

  #closeServer(socket: Socket): void {
    this.#activeSessions.delete(socket);
  }
};

for (const supervisor of Supervisor) {
  supervisor.start();
}
