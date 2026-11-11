import { SuiGrpcClient } from "@mysten/sui/grpc";
import { suiRpcUrl } from "./config";

/** The Sui node our server reads through. The browser never needs a Sui RPC of its own. */
export function suiClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: "mainnet", baseUrl: suiRpcUrl() });
}
