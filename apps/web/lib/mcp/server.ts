import { liveDeps } from "../api/wiring";
import type { Server } from "./protocol";
import { buildTools } from "./tools";

export const server: Server = {
  info: { name: "xebra", title: "Xebra", version: "1.0.0" },
  instructions:
    "Xebra (xebra.exchange) is a non-custodial bridge for native USDC, built on Circle CCTP: USDC is burned on the source chain and minted as native USDC on the destination, with no wrapped token and no custody. Use list_routes to see what is live, quote_transfer to price a route, and create_transfer_link to give the user a link where they review and sign the transfer in their own wallet. You cannot send funds yourself and no tool signs anything; always tell the user to check the recipient address before approving. A transfer cannot be reversed once signed.",
  tools: buildTools(liveDeps),
};
