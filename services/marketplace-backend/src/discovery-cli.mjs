/**
 * CLI runner for Starknet deployment and upgrade discovery.
 *
 * Usage:
 *   node services/marketplace-backend/src/discovery-cli.mjs probe --rpc <url>
 *   node services/marketplace-backend/src/discovery-cli.mjs scan --rpc <url> --from <block> --to <block>
 *   node services/marketplace-backend/src/discovery-cli.mjs resume --rpc <url>
 *
 * @module discovery-cli
 */

import { parseArgs } from "node:util";
import { RpcClient } from "./rpc.mjs";
import {
  probeRpcCapabilities,
  discoverRange,
  resumeDiscovery,
  createMemoryDiscoveryStore,
} from "./discovery.mjs";

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      rpc: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      chain: { type: "string", default: "SN_MAIN" },
      batchSize: { type: "string", default: "10" },
    },
    allowPositionals: true,
  });

  const command = positionals[0] ?? "probe";
  const rpcUrl = values.rpc || process.env.STARKNET_RPC_URL;
  if (!rpcUrl) {
    console.error("Error: --rpc <url> or STARKNET_RPC_URL environment variable is required.");
    process.exit(1);
  }

  const rpc = new RpcClient([rpcUrl]);
  const chainId = values.chain;
  const store = createMemoryDiscoveryStore();

  if (command === "probe") {
    console.log(`Probing RPC capabilities at ${rpcUrl}...`);
    const probe = await probeRpcCapabilities(rpc);
    console.log(JSON.stringify(probe, null, 2));
    return;
  }

  if (command === "scan") {
    const from = Number(values.from ?? 0);
    const to = Number(values.to ?? from);
    const batchSize = Number(values.batchSize);

    console.log(`Discovering deployments from block ${from} to ${to}...`);
    const result = await discoverRange(rpc, store, chainId, from, to, {
      batchSize,
      onProgress: (block, stats) => {
        console.log(`Block ${block}: found ${stats.deployments} deployments, ${stats.classChanges} class changes`);
      },
    });

    console.log("Discovery complete:");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "resume") {
    console.log("Resuming discovery from latest checkpoint...");
    const result = await resumeDiscovery(rpc, store, chainId, {
      batchSize: Number(values.batchSize),
      onProgress: (block, stats) => {
        console.log(`Block ${block}: found ${stats.deployments} deployments, ${stats.classChanges} class changes`);
      },
    });

    console.log("Discovery run complete:");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
