import { EventEmitter } from "node:events";

const OLLAMA_API_BASE = "http://127.0.0.1:11434";

export type AutonomousModeState = "connected" | "disconnected" | "autonomous";

export type AutonomousModeConfig = {
  /** Model to use when autonomous (e.g., "llama3.2:latest") */
  model?: string;
  /** Timeout before switching to autonomous after disconnect (ms) */
  gracePeriodMs?: number;
  /** Whether autonomous mode is enabled */
  enabled?: boolean;
  /** System prompt for autonomous mode */
  systemPrompt?: string;
};

export type QueuedStateChange = {
  type: "session_message" | "memory_update";
  timestamp: number;
  payload: unknown;
};

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class AutonomousModeManager extends EventEmitter {
  private state: AutonomousModeState = "connected";
  private config: AutonomousModeConfig;
  private stateQueue: QueuedStateChange[] = [];
  private gracePeriodTimer: NodeJS.Timeout | null = null;
  private availableModels: string[] = [];
  private ollamaReady = false;

  constructor(config: AutonomousModeConfig = {}) {
    super();
    this.config = {
      model: config.model ?? "llama3.2:latest",
      gracePeriodMs: config.gracePeriodMs ?? 5000,
      enabled: config.enabled ?? true,
      systemPrompt: config.systemPrompt ?? "You are a helpful AI assistant running in offline mode. Be concise and helpful.",
    };
  }

  /** Check if Ollama is available and discover models */
  async initialize(): Promise<boolean> {
    if (!this.config.enabled) {
      console.log("[autonomous] Disabled by config");
      return false;
    }

    try {
      const response = await fetch(`${OLLAMA_API_BASE}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        console.warn("[autonomous] Ollama not available");
        return false;
      }

      const data = (await response.json()) as { models: Array<{ name: string }> };
      this.availableModels = data.models?.map((m) => m.name) ?? [];

      if (this.availableModels.length === 0) {
        console.warn("[autonomous] No Ollama models available");
        return false;
      }

      // Verify configured model exists, or pick first available
      if (!this.availableModels.includes(this.config.model!)) {
        const oldModel = this.config.model;
        this.config.model = this.availableModels[0];
        console.log(`[autonomous] Model '${oldModel}' not found, using: ${this.config.model}`);
      }

      this.ollamaReady = true;
      console.log(`[autonomous] Ready with ${this.availableModels.length} models: ${this.availableModels.join(", ")}`);
      return true;
    } catch (err) {
      console.warn(`[autonomous] Ollama check failed: ${err}`);
      return false;
    }
  }

  /** Called when gateway connection is lost */
  onDisconnect(): void {
    if (!this.config.enabled || !this.ollamaReady) {
      return;
    }

    if (this.state === "connected") {
      this.state = "disconnected";
      this.emit("stateChange", this.state);
      console.log(`[autonomous] Disconnected, waiting ${this.config.gracePeriodMs}ms before autonomous mode`);

      // Start grace period before going autonomous
      this.gracePeriodTimer = setTimeout(() => {
        if (this.state === "disconnected") {
          this.enterAutonomousMode();
        }
      }, this.config.gracePeriodMs);
    }
  }

  /** Called when gateway connection is restored */
  onReconnect(): void {
    if (this.gracePeriodTimer) {
      clearTimeout(this.gracePeriodTimer);
      this.gracePeriodTimer = null;
    }

    const wasAutonomous = this.state === "autonomous";
    this.state = "connected";
    this.emit("stateChange", this.state);
    console.log("[autonomous] Reconnected to gateway");

    if (wasAutonomous) {
      void this.syncQueuedChanges();
    }
  }

  /** Switch to autonomous mode */
  private enterAutonomousMode(): void {
    if (this.availableModels.length === 0) {
      console.error("[autonomous] Cannot enter autonomous mode: no models available");
      return;
    }

    this.state = "autonomous";
    this.emit("stateChange", this.state);
    console.log(`[autonomous] Entered autonomous mode using ${this.config.model}`);
  }

  /** Sync queued changes back to gateway */
  private async syncQueuedChanges(): Promise<void> {
    if (this.stateQueue.length === 0) {
      console.log("[autonomous] No queued changes to sync");
      return;
    }

    console.log(`[autonomous] Syncing ${this.stateQueue.length} queued changes`);
    // TODO: Implement sync protocol with gateway
    // For now, just log and clear
    for (const change of this.stateQueue) {
      console.log(`[autonomous] Would sync: ${change.type} from ${new Date(change.timestamp).toISOString()}`);
    }
    this.stateQueue = [];
  }

  /** Queue a state change for later sync */
  queueChange(change: Omit<QueuedStateChange, "timestamp">): void {
    this.stateQueue.push({
      ...change,
      timestamp: Date.now(),
    });
  }

  /** Check if we're in autonomous mode */
  isAutonomous(): boolean {
    return this.state === "autonomous";
  }

  /** Get current state */
  getState(): AutonomousModeState {
    return this.state;
  }

  /** Get available models */
  getModels(): string[] {
    return this.availableModels;
  }

  /** Get current model */
  getModel(): string | undefined {
    return this.config.model;
  }

  /** Generate a chat completion via Ollama */
  async chat(params: {
    messages: ChatMessage[];
    stream?: boolean;
  }): Promise<string> {
    if (!this.isAutonomous()) {
      throw new Error("Not in autonomous mode");
    }

    // Prepend system prompt if not already present
    const messages = [...params.messages];
    if (messages[0]?.role !== "system" && this.config.systemPrompt) {
      messages.unshift({ role: "system", content: this.config.systemPrompt });
    }

    const response = await fetch(`${OLLAMA_API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama chat failed: ${response.status} - ${text}`);
    }

    const data = (await response.json()) as { message: { content: string } };
    return data.message.content;
  }

  /** Generate a streaming chat completion via Ollama */
  async *chatStream(params: {
    messages: ChatMessage[];
  }): AsyncGenerator<string, void, unknown> {
    if (!this.isAutonomous()) {
      throw new Error("Not in autonomous mode");
    }

    // Prepend system prompt if not already present
    const messages = [...params.messages];
    if (messages[0]?.role !== "system" && this.config.systemPrompt) {
      messages.unshift({ role: "system", content: this.config.systemPrompt });
    }

    const response = await fetch(`${OLLAMA_API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama chat stream failed: ${response.status} - ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
            if (data.message?.content) {
              yield data.message.content;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// Singleton for easy access
let _instance: AutonomousModeManager | null = null;

export function getAutonomousModeManager(): AutonomousModeManager | null {
  return _instance;
}

export function initAutonomousModeManager(config?: AutonomousModeConfig): AutonomousModeManager {
  _instance = new AutonomousModeManager(config);
  return _instance;
}
