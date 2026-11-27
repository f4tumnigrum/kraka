import type { ProviderAdapter } from "@kraka/environment";
import type { AcpConnection, AcpTransport } from "./acp";

export type AcpSessionHandle = {
  transport: AcpTransport<AcpConnection>;
  connection: AcpConnection;
};
export type AcpAdapterFactory = (
  transport: AcpTransport<AcpConnection>,
) => ProviderAdapter<"acp", AcpSessionHandle>;
export declare const createAcpAdapter: AcpAdapterFactory;
export type { AcpConnection, AcpFrame, AcpLaunchSpec, AcpTransport } from "./acp";
