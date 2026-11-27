import { FlowPeer, type FlowPort } from "./flow-peer";
import { OversizedControlFrame, type WireMessage } from "./stream-codec";
import type { ConnectionId } from "./ids";
import { ControlContentReceiver, sendLogicalContent } from "./logical-control";
import type { ControlMessage } from "./transport";

/** Multiplex authorized logical messages that exceed one control frame. */
export class ControlStream {
  private readonly flow: FlowPeer;
  private readonly incoming: ControlContentReceiver;
  private readonly sent = new Set<number>();
  constructor(
    epoch: ConnectionId,
    private readonly port: FlowPort,
    private readonly authorized: () => boolean,
    receive: (value: ControlMessage) => void,
  ) {
    this.flow = new FlowPeer(epoch, port, {
      control: (message) => {
        if (message.kind !== "transport.content") {
          receive(message);
          return;
        }
        if (!authorized()) throw Error("Unauthenticated content stream");
        this.incoming.declare(message);
      },
      data: (frame, size) => {
        if (!authorized()) throw Error("Unauthenticated content stream");
        const msg = this.incoming.read(frame, size);
        if (!msg) return;
        if (
          msg.kind !== "signedRequest" &&
          msg.kind !== "accepted" &&
          msg.kind !== "rejected" &&
          msg.kind !== "programError"
        )
          throw Error("Unexpected logical control message");
        receive(msg);
      },
      discarded: (id) => {
        this.incoming.drop(id);
        throw Error("Invalid logical control stream");
      },
    });
    this.incoming = new ControlContentReceiver(this.flow, Infinity);
  }
  input(wire: WireMessage) {
    this.flow.input(wire);
    for (const id of this.sent) if (this.flow.send.releaseConsumed(id)) this.sent.delete(id);
    this.flow.pump();
  }
  send(message: ControlMessage) {
    const utf8 = this.port.utf8;
    try {
      this.flow.control(message);
    } catch (error) {
      if (
        !(error instanceof OversizedControlFrame) ||
        !this.authorized() ||
        !(
          message.kind === "signedRequest" ||
          message.kind === "accepted" ||
          message.kind === "rejected" ||
          message.kind === "programError"
        )
      )
        throw error;
      const bytes = utf8.encode(JSON.stringify(message));
      sendLogicalContent(this.flow, bytes, message.commandId, (id) => this.sent.add(id));
    }
    this.flow.pump();
  }
  close() {
    this.incoming.clear();
    this.sent.clear();
    this.flow.close();
  }
}
