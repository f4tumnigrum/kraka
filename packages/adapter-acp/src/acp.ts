import type { AdapterCallResult } from "@kraka/environment";

export type AcpConnection = { readonly connection: object };
export type AcpFrame = unknown;
export type AcpLaunchSpec = {
  command: string;
  args: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
};

/** The ACP package owns shared frame transport mechanics. Family packages own versioned frame schemas and translation. */
export interface AcpTransport<Connection extends AcpConnection> {
  open(spec: AcpLaunchSpec): Promise<AdapterCallResult<Connection>>;
  send(connection: Connection, frame: AcpFrame): Promise<AdapterCallResult<void>>;
  frames(
    connection: Connection,
    after: string | null,
  ): AsyncIterable<{ cursor: string | null; frame: AcpFrame }>;
  close(connection: Connection): Promise<AdapterCallResult<void>>;
}
