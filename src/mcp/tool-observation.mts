import {McpServer} from '@modelcontextprotocol/server';

export type ToolOutcome = 'success' | 'tool_error' | 'protocol_error' | 'disconnected';
export interface ToolObservation {
  /** Registered name, or null when the caller requested an unknown tool. */
  tool: string | null;
  /** Untrusted client declaration, when supplied by the protocol. */
  client: string | null;
}
export type ObserveTool = (call: ToolObservation) => (outcome: ToolOutcome) => void;
type Transport = Parameters<McpServer['connect']>[0];

/** Observe the SDK's decoded exchanges on both protocol generations, before
 * validation and before encoding JSON/SSE. Never copy tool arguments or results. */
export class ObservableMcpServer extends McpServer {
  observeTool?: ObserveTool;

  override async connect(transport: Transport) {
    await super.connect(transport);
    const observe = this.observeTool;
    if (!observe) return;
    // HTTP dispatch begins after connect. Legacy requests can share a transport.
    const pending = new Map<string | number, ReturnType<ObserveTool>>();
    const receive = transport.onmessage;
    const send = transport.send.bind(transport);
    const close = transport.onclose;
    const finish = (id: string | number, outcome: ToolOutcome) => {
      const done = pending.get(id);
      pending.delete(id);
      try { done?.(outcome); } catch { /* Optional observation cannot affect dispatch. */ }
    };
    transport.onmessage = (message, extra) => {
      if ('method' in message && message.method === 'tools/call' && 'id' in message) {
        try {
          const name = message.params?.name;
          const info = message.params?._meta?.['io.modelcontextprotocol/clientInfo'];
          const client = info && typeof info === 'object' && 'name' in info && typeof info.name === 'string' ? info.name.slice(0,100) : null;
          const tool = typeof name === 'string' && this.toolInputSchemaJson(name) ? name : null;
          if (pending.has(message.id)) finish(message.id, 'protocol_error');
          pending.set(message.id, observe({tool, client}));
        } catch { /* Keep the original request and its authorization path. */ }
      }
      receive?.(message, extra);
    };
    transport.send = (message, options) => {
      if ('id' in message && message.id != null && !('method' in message)) {
        finish(message.id, 'error' in message ? 'protocol_error' : message.result.isError === true ? 'tool_error' : 'success');
      }
      return send(message, options);
    };
    transport.onclose = () => {
      for (const id of pending.keys()) finish(id, 'disconnected');
      close?.();
    };
  }
}
