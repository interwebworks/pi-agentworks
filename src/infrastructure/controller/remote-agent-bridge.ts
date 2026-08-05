/**
 * Remote Pi child bridge for authenticated agent communication.
 */

import { Socket, createConnection } from "node:net"
import { writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

export interface RemoteAgentBridgeOptions {
  readonly socketPath: string
  readonly controllerToken: string
  readonly runId: string
  readonly agentId: string
  readonly sessionId: string
}

export interface RemoteAgentBridge {
  readonly options: RemoteAgentBridgeOptions
  readonly sessionId: string
  close(): void
  connect(): Promise<void>
  send(payload: unknown): Promise<void>
  sendSupervisor(data: RemoteAgentBridge.SupervisorData): Promise<void>
  waitForResult(): Promise<RemoteAgentBridge.Result | never>
}

export namespace RemoteAgentBridge {
  export type SupervisorData =
    | { type: "nudge"; runId: string; agentId: string; reason: "idle" | "blocked" | "timeout" }
    | { type: "completion"; runId: string; agentId: string; outcome: "success" | "early" | "over"; revision: number | null }
    | { type: "error"; runId: string; agentId: string; code: string; message: string }

  export type Result =
    | { stage: "launch" | "ready" | "waiting" | "blocked" | "running" | "complete" | "shutting_down" | "shutdown" | "recovery"; output: string | null; elapsedMs: number | null }
    | { stage: "supervisor"; data: SupervisorData }
}

async function bytesToHex(bytes: Buffer | Uint8Array): Promise<string> {
  return new Promise((resolveBytesToHex) => {
    const array = new Uint8Array(bytes)
    const hexArray = Array(array.length).fill(0).map((_, i) => array[i].toString(16).padStart(2, "0"))
    resolveBytesToHex(hexArray.join(""))
  })
}

class InvalidBridgeMessageError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Invalid bridge message:\n- ${issues.join("\n- ")}`)
    this.name = "InvalidBridgeMessageError"
    this.issues = issues
  }
}

function log(message: string): void {
  const trace = `Bridge [${message}]`
  console.warn(trace)
}

export function connectRemoteAgentBridge(options: RemoteAgentBridgeOptions): RemoteAgentBridge {
  const { socketPath, controllerToken, runId, agentId, sessionId } = options
  const hexSocketPath = bytesToHex(Buffer.from(socketPath))
  const hexToken = bytesToHex(Buffer.from(controllerToken)).slice(0, 24)
  const hexRunId = bytesToHex(Buffer.from(runId)).slice(0, 32)
  const hexAgent = agentId.slice(0, 16)
  const hexSession = sessionId.slice(0, 16)
  log(`connected ${hexToken}... ${hexRunId}... ${hexAgent}... ${hexSession} at ${hexSocketPath.slice(0, 32)}...`)

  const close = () => {
    socket!.destroy()
  }

  const socket = createConnection(Buffer.from(socketPath), onConnect)
  
  function onConnect(): void {
    log(`socket acknowledged connected`)
    const requestId = randomUUID()
    const payload = { payload: { runId, agentId, sessionId, version: 1 }, id: requestId, action: "agent.hello" }
    try {
      socket.write(JSON.stringify(payload))
    } catch {
      log("write failed")
    }
  }

  return {
    options,
    sessionId,
    close,
    connect: async () => {
      return new Promise<void>((resolveConnect, rejectConnect) => socket.once("error", rejectConnect))
    },
    send: async (data) => {
      try {
        socket.write(JSON.stringify(data))
      } catch {
        log("send failed")
      }
    },
    sendSupervisor: async (data) => {
      console.log(`supervisor ${JSON.stringify(data)}`)
      return this.send({ type: "supervisor", data })
    },
    waitForResult: async () => {
      log("waiting for result")
      throw new Error("Not yet implemented")
    }
  }
}

export function createRemoteAgentBridge(options: RemoteAgentBridgeOptions): RemoteAgentBridge {
  return connectRemoteAgentBridge(options)
}
