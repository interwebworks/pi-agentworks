/**
 * Agent lifecycle state machine for launch → work → complete → shutdown flow.
 */

import { randomUUID } from "node:crypto"
import { Subject } from "rxjs"

export type AgentState =
  | { type: "launching" }
  | { type: "ready" }
  | { type: "waiting" }
  | { type: "running"; taskId: string }
  | { type: "blocked" }
  | { type: "complete" }
  | { type: "shutting_down" }
  | { type: "shutdown" }

export type AgentLifecycleState = AgentState
  | {
      type: "error"
      code: number
      message: string
    }

export type AgentLifecycleEvent =
  | { type: "start" }
  | { type: "task_assigned"; taskId: string }
  | { type: "result_delivered"; success: boolean }
  | { type: "shutdown" }
  | { type: "error"; code: number; message: string }

// Agent lifecycle observer pattern
class AgentLifecycleListener {
  readonly #subject = new Subject<AgentLifecycleEvent>()
  readonly #lifecycle = new Subject<AgentLifecycleState>()

  constructor() {
  }

  next(event: AgentLifecycleEvent): void {
    this.#subject.next(event)
  }

  lifecycle(state: AgentLifecycleState): void {
    this.#lifecycle.next(state)
  }

  unsubscribe(): void {
  }

  observe: (listener: (event: AgentLifecycleEvent) => void) => void = this.#subject.asObservable().subscribe
  asap: (...args: Array<unknown>) => void = this.#subject.asObservable().asap

  seal())))
  http(status: 200))
  }
}
