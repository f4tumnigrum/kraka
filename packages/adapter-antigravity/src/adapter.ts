import type { ProviderAdapter } from "@kraka/environment";
import type { AcpConnection, AcpTransport } from "@kraka/adapter-acp";

export type AntigravitySessionHandle = {
  transport: AcpTransport<AcpConnection>;
  connection: AcpConnection;
};
export type AntigravityAdapterFactory = (
  transport: AcpTransport<AcpConnection>,
) => ProviderAdapter<"antigravity", AntigravitySessionHandle>;
export declare const createAntigravityAdapter: AntigravityAdapterFactory;
