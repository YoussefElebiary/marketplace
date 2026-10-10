/**
 * Discovery scanner for Starknet contract deployments and upgrades.
 *
 * Walks canonical state updates from the earliest available chain history
 * and tails accepted blocks. Persists deployed contracts and class
 * replacements, and supplements with receipt event-emitter candidates.
 * Discovery finds inactive/zero-mint collections as well as active ones.
 *
 * @module discovery
 */

import { ApiError } from "./domain.mjs";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Universal Deployer Contract address on Starknet mainnet. */
export const UDC_ADDRESS =
  "0x041a78e741e5af2fec34b695679bc6891742439f7afb8484ecd7766661ad02bf";

/**
 * sn_keccak("ContractDeployed") — UDC event selector.
 * Verified against Starknet mainnet UDC contract events.
 */
export const CONTRACT_DEPLOYED_KEY =
  "0x26b160f10156dea0cae30d1acabc1fcb94e6e55d5ff6f24e08c5ad5b17caeb4";

/**
 * sn_keccak("Upgraded") — OpenZeppelin upgradeable event selector.
 * Verified against known collection upgrade transactions on Starknet mainnet.
 */
export const UPGRADED_KEY =
  "0x90890809c654f11d6e72a28731ceba1cf09c8a766891afb12019e9bae0ed85";

/** Maximum blocks in a single discovery batch. */
const DEFAULT_BATCH_SIZE = 10;

/** Binary search depth limit for RPC probing. */
const MAX_PROBE_ITERATIONS = 64;

// ─── Address Utilities ────────────────────────────────────────────────────────

/**
 * Normalize a Starknet felt to its canonical lowercase hex representation.
 * Strips leading zeros after the 0x prefix.
 *
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeAddress(raw) {
  if (!raw) return "0x0";
  try {
    const n = BigInt(raw);
    return "0x" + n.toString(16).toLowerCase();
  } catch {
    const hex = String(raw).replace(/^0x0*/i, "");
    return "0x" + (hex || "0").toLowerCase();
  }
}

/**
 * Compare two felt values for equality after normalization.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function feltEqual(a, b) {
  if (!a || !b) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
}

// ─── RPC Capability Probing ───────────────────────────────────────────────────

/**
 * Probe an RPC endpoint to determine its capabilities and the earliest
 * available block. Records supported methods and gaps in availability.
 *
 * Binary-searches for the earliest block returning a valid response from
 * `starknet_getBlockWithTxHashes`.
 *
 * @param {import("./rpc.mjs").RpcClient} rpc
 * @returns {Promise<object>}
 */
export async function probeRpcCapabilities(rpc) {
  const result = {
    probeTime: new Date().toISOString(),
    earliestAvailableBlock: null,
    latestBlock: null,
    supportsGetBlockWithReceipts: true,
    supportsGetEvents: true,
    supportsGetClassHashAt: true,
    gaps: [],
    errors: [],
  };

  // Determine latest block
  try {
    const latest = await rpc.call("starknet_blockNumber");
    result.latestBlock = Number(latest);
  } catch (err) {
    result.errors.push({
      method: "starknet_blockNumber",
      message: err.message,
    });
    return result;
  }

  // Probe starknet_getBlockWithReceipts support
  try {
    await rpc.call("starknet_getBlockWithReceipts", {
      block_id: { block_number: result.latestBlock },
    });
  } catch (err) {
    if (isMethodNotFoundError(err)) {
      result.supportsGetBlockWithReceipts = false;
      result.errors.push({
        method: "starknet_getBlockWithReceipts",
        message: "Method not supported",
      });
    }
  }

  // Probe starknet_getEvents support
  try {
    await rpc.call("starknet_getEvents", {
      filter: {
        from_block: { block_number: result.latestBlock },
        to_block: { block_number: result.latestBlock },
        chunk_size: 1,
      },
    });
  } catch (err) {
    if (isMethodNotFoundError(err)) {
      result.supportsGetEvents = false;
      result.errors.push({
        method: "starknet_getEvents",
        message: "Method not supported",
      });
    }
  }

  // Binary search for earliest available block
  let lo = 0;
  let hi = result.latestBlock;
  let iterations = 0;

  while (lo < hi && iterations < MAX_PROBE_ITERATIONS) {
    const mid = Math.floor(lo + (hi - lo) / 2);
    iterations++;
    try {
      await rpc.call("starknet_getBlockWithTxHashes", {
        block_id: { block_number: mid },
      });
      hi = mid;
    } catch (err) {
      if (isBlockNotFoundError(err)) {
        lo = mid + 1;
      } else {
        result.gaps.push({
          from: mid,
          to: mid,
          reason: err.message,
        });
        lo = mid + 1;
      }
    }
  }

  result.earliestAvailableBlock = lo;
  return result;
}

// ─── Block Processing ─────────────────────────────────────────────────────────

/**
 * Extract deployments, upgrades, and event emitters from a single block
 * with receipts. Pure function — no side effects.
 *
 * @param {{ block_number: number, block_hash: string, transactions: object[] }} block
 * @returns {{ deployments: object[], classChanges: object[], eventEmitters: Set<string> }}
 */
export function extractDiscoveries(block) {
  const blockNumber = block.block_number;
  const blockHash = block.block_hash;
  const deployments = [];
  const classChanges = [];
  const eventEmitters = new Set();

  const txEntries = block.transactions ?? [];

  for (let txIdx = 0; txIdx < txEntries.length; txIdx++) {
    const entry = txEntries[txIdx];
    const tx = entry.transaction ?? entry;
    const receipt = entry.receipt ?? {};
    const txHash =
      tx.transaction_hash ?? receipt.transaction_hash ?? null;

    // Skip reverted transactions — contract was not actually deployed
    if (receipt.execution_status === "REVERTED") continue;

    // ── DEPLOY transactions (legacy, pre Starknet 0.10) ──
    if (tx.type === "DEPLOY") {
      const contractAddr = normalizeAddress(
        tx.contract_address ?? receipt.contract_address,
      );
      const classHash = normalizeAddress(tx.class_hash);
      deployments.push({
        contractAddress: contractAddr,
        classHash,
        deployerAddress: null,
        blockNumber,
        blockHash,
        transactionHash: txHash,
        transactionIndex: txIdx,
        deployType: "deploy_txn",
        constructorCalldata: tx.constructor_calldata ?? [],
      });
      classChanges.push({
        contractAddress: contractAddr,
        previousClassHash: null,
        newClassHash: classHash,
        blockNumber,
        blockHash,
        transactionHash: txHash,
        eventIndex: null,
        changeType: "deploy",
      });
    }

    // ── DEPLOY_ACCOUNT transactions ──
    if (tx.type === "DEPLOY_ACCOUNT") {
      const contractAddr = normalizeAddress(
        receipt.contract_address ?? tx.sender_address,
      );
      const classHash = normalizeAddress(tx.class_hash);
      deployments.push({
        contractAddress: contractAddr,
        classHash,
        deployerAddress: null,
        blockNumber,
        blockHash,
        transactionHash: txHash,
        transactionIndex: txIdx,
        deployType: "deploy_account_txn",
        constructorCalldata: tx.constructor_calldata ?? [],
      });
      classChanges.push({
        contractAddress: contractAddr,
        previousClassHash: null,
        newClassHash: classHash,
        blockNumber,
        blockHash,
        transactionHash: txHash,
        eventIndex: null,
        changeType: "deploy",
      });
    }

    // ── Receipt events ──
    const events = receipt.events ?? [];
    for (let evIdx = 0; evIdx < events.length; evIdx++) {
      const event = events[evIdx];
      const emitter = normalizeAddress(event.from_address);
      eventEmitters.add(emitter);

      const keys = event.keys ?? [];
      const data = event.data ?? [];

      // UDC ContractDeployed event (Cairo 0 layout):
      // keys: [selector]
      // data: [address, deployer, unique, classHash, calldata_len, ...calldata, salt]
      if (
        feltEqual(emitter, UDC_ADDRESS) &&
        keys.length > 0 &&
        feltEqual(keys[0], CONTRACT_DEPLOYED_KEY)
      ) {
        const deployedAddress = normalizeAddress(data[0]);
        const deployer = normalizeAddress(data[1]);
        const deployClassHash = normalizeAddress(data[3]);
        const calldataLen = Number(data[4] ?? "0");
        const constructorCalldata = data.slice(5, 5 + calldataLen);

        deployments.push({
          contractAddress: deployedAddress,
          classHash: deployClassHash,
          deployerAddress: deployer,
          blockNumber,
          blockHash,
          transactionHash: txHash,
          transactionIndex: txIdx,
          deployType: "udc",
          constructorCalldata,
        });
        classChanges.push({
          contractAddress: deployedAddress,
          previousClassHash: null,
          newClassHash: deployClassHash,
          blockNumber,
          blockHash,
          transactionHash: txHash,
          eventIndex: evIdx,
          changeType: "deploy",
        });
      }

      // Upgraded event — supports both Cairo 0 and Cairo 1 layouts.
      // Cairo 0: keys=[selector], data=[new_class_hash]
      // Cairo 1 component: keys=[component_selector, selector], data=[new_class_hash]
      const isUpgraded = keys.some((k) => feltEqual(k, UPGRADED_KEY));
      if (isUpgraded && data.length > 0) {
        const newClassHash = normalizeAddress(data[0]);
        if (newClassHash !== "0x0") {
          classChanges.push({
            contractAddress: emitter,
            previousClassHash: null,
            newClassHash,
            blockNumber,
            blockHash,
            transactionHash: txHash,
            eventIndex: evIdx,
            changeType: "upgrade",
          });
        }
      }
    }
  }

  return { deployments, classChanges, eventEmitters };
}

// ─── Range Scanner ────────────────────────────────────────────────────────────

/**
 * Scan a bounded range of blocks for contract deployments and upgrades.
 * Checkpoints commit atomically with discoveries at each batch boundary.
 *
 * @param {import("./rpc.mjs").RpcClient} rpc
 * @param {object} store - Discovery store ({@link createDiscoveryStore})
 * @param {string} chainId
 * @param {number} from - inclusive start block
 * @param {number} to - inclusive end block
 * @param {object} [options]
 * @param {number} [options.batchSize=10]
 * @param {function} [options.onProgress] - callback(blockNumber, batchStats)
 * @returns {Promise<object>} scan result summary
 */
export async function discoverRange(
  rpc,
  store,
  chainId,
  from,
  to,
  options = {},
) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const onProgress = options.onProgress ?? (() => {});

  let totalDeployments = 0;
  let totalClassChanges = 0;
  let totalEventEmitters = 0;
  let blocksScanned = 0;
  const gaps = [];

  let cursor = from;

  while (cursor <= to) {
    const batchEnd = Math.min(cursor + batchSize - 1, to);
    const batchBlocks = [];

    // Fetch blocks with receipts sequentially (each can be up to 16 MB).
    for (let bn = cursor; bn <= batchEnd; bn++) {
      try {
        const block = await rpc.call("starknet_getBlockWithReceipts", {
          block_id: { block_number: bn },
        });
        batchBlocks.push(block);
      } catch (err) {
        if (isBlockNotFoundError(err)) {
          gaps.push({ from: bn, to: bn, reason: "BLOCK_NOT_FOUND" });
          continue;
        }
        throw err;
      }
    }

    // Extract discoveries from each block in the batch.
    const batchDeployments = [];
    const batchClassChanges = [];
    const batchEmitters = new Set();
    let lastBlockHash = null;
    let lastBlockNumber = cursor;

    for (const block of batchBlocks) {
      const discoveries = extractDiscoveries(block);
      batchDeployments.push(...discoveries.deployments);
      batchClassChanges.push(...discoveries.classChanges);
      for (const addr of discoveries.eventEmitters) batchEmitters.add(addr);
      lastBlockHash = block.block_hash;
      lastBlockNumber = block.block_number;
    }

    // Commit batch atomically with checkpoint.
    if (batchBlocks.length > 0) {
      await store.commitDiscoveries({
        chainId,
        deployments: batchDeployments,
        classChanges: batchClassChanges,
        eventEmitters: [...batchEmitters],
        checkpoint: {
          chainId,
          blockNumber: lastBlockNumber,
          blockHash: lastBlockHash,
        },
      });
    }

    totalDeployments += batchDeployments.length;
    totalClassChanges += batchClassChanges.length;
    totalEventEmitters += batchEmitters.size;
    blocksScanned += batchEnd - cursor + 1;

    onProgress(lastBlockNumber, {
      deployments: batchDeployments.length,
      classChanges: batchClassChanges.length,
    });

    cursor = batchEnd + 1;
  }

  return {
    from,
    to,
    blocksScanned,
    totalDeployments,
    totalClassChanges,
    totalEventEmitters,
    gaps,
  };
}

/**
 * Resume discovery scanning from the last checkpoint, or from the specified
 * start block if no checkpoint exists.
 *
 * @param {import("./rpc.mjs").RpcClient} rpc
 * @param {object} store
 * @param {string} chainId
 * @param {object} [options]
 * @param {number} [options.startBlock=0] - fallback when no checkpoint exists
 * @param {number} [options.endBlock] - defaults to latest accepted block
 * @param {number} [options.batchSize]
 * @param {function} [options.onProgress]
 * @returns {Promise<object>}
 */
export async function resumeDiscovery(rpc, store, chainId, options = {}) {
  const checkpoint = await store.getCheckpoint(chainId);
  const from = checkpoint
    ? checkpoint.blockNumber + 1
    : (options.startBlock ?? 0);

  let to = options.endBlock;
  if (to === undefined) {
    to = Number(await rpc.call("starknet_blockNumber"));
  }

  if (from > to) {
    return {
      from,
      to,
      blocksScanned: 0,
      totalDeployments: 0,
      totalClassChanges: 0,
      totalEventEmitters: 0,
      gaps: [],
    };
  }

  return discoverRange(rpc, store, chainId, from, to, options);
}

/**
 * Check for reorgs by verifying the checkpoint block hash against the
 * canonical chain. Rewinds discovery and invalidates dependent data
 * when a reorganisation is detected.
 *
 * @param {import("./rpc.mjs").RpcClient} rpc
 * @param {object} store
 * @param {string} chainId
 * @returns {Promise<{ reorged: boolean, rewindTo?: number }>}
 */
export async function handleReorg(rpc, store, chainId) {
  const checkpoint = await store.getCheckpoint(chainId);
  if (!checkpoint) return { reorged: false };

  try {
    const canonical = await rpc.call("starknet_getBlockWithTxHashes", {
      block_id: { block_number: checkpoint.blockNumber },
    });
    if (canonical.block_hash === checkpoint.blockHash) {
      return { reorged: false };
    }
  } catch (err) {
    if (!isBlockNotFoundError(err)) throw err;
    // Block not found — chain may have reorganised past this point.
  }

  // Walk backward to find the matching canonical ancestor.
  let target = checkpoint.blockNumber - 1;
  while (target >= 0) {
    try {
      const block = await rpc.call("starknet_getBlockWithTxHashes", {
        block_id: { block_number: target },
      });
      await store.rewindTo(chainId, target, block.block_hash);
      return { reorged: true, rewindTo: target };
    } catch (err) {
      if (isBlockNotFoundError(err)) {
        target--;
        continue;
      }
      throw err;
    }
  }

  await store.rewindTo(chainId, -1, null);
  return { reorged: true, rewindTo: -1 };
}

// ─── Error Classification ─────────────────────────────────────────────────────

/**
 * @param {Error} err
 * @returns {boolean}
 */
export function isBlockNotFoundError(err) {
  const msg = err.message ?? "";
  const code = err.details?.rpcCode ?? err.code ?? 0;
  return (
    code === 24 ||
    msg.includes("BLOCK_NOT_FOUND") ||
    msg.includes("Block not found")
  );
}

/**
 * @param {Error} err
 * @returns {boolean}
 */
export function isMethodNotFoundError(err) {
  const msg = err.message ?? "";
  const code = err.details?.rpcCode ?? err.code ?? 0;
  return (
    code === -32601 ||
    msg.includes("METHOD_NOT_FOUND") ||
    msg.includes("Method not found")
  );
}

// ─── In-Memory Store Factory (for fast testing / ephemeral runs) ──────────────

/**
 * Creates an in-memory discovery store matching the PostgreSQL discovery store interface.
 * Useful for tests, rehearsals, and dry-runs without a PostgreSQL server.
 *
 * @returns {object}
 */
export function createMemoryDiscoveryStore() {
  const checkpoints = new Map();
  const deployments = new Map();
  const classChanges = [];
  let classChangeId = 1;
  const eventEmitters = new Map();
  const rpcProbes = [];

  return {
    async getCheckpoint(chainId) {
      const cp = checkpoints.get(chainId);
      return cp ? { ...cp } : null;
    },

    async commitDiscoveries(batch) {
      for (const d of batch.deployments) {
        const key = `${batch.chainId}:${d.contractAddress}`;
        if (!deployments.has(key)) {
          deployments.set(key, {
            ...d,
            chainId: batch.chainId,
            discoveredAt: new Date().toISOString(),
          });
        }
      }
      for (const cc of batch.classChanges) {
        classChanges.push({
          id: classChangeId++,
          ...cc,
          chainId: batch.chainId,
          discoveredAt: new Date().toISOString(),
        });
      }
      for (const addr of batch.eventEmitters) {
        const key = `${batch.chainId}:${addr}`;
        const existing = eventEmitters.get(key);
        if (existing) {
          existing.lastSeenBlock = Math.max(
            existing.lastSeenBlock,
            batch.checkpoint.blockNumber,
          );
          existing.eventCount++;
        } else {
          eventEmitters.set(key, {
            chainId: batch.chainId,
            contractAddress: addr,
            firstSeenBlock: batch.checkpoint.blockNumber,
            lastSeenBlock: batch.checkpoint.blockNumber,
            eventCount: 1,
          });
        }
      }
      checkpoints.set(batch.checkpoint.chainId, {
        chainId: batch.checkpoint.chainId,
        blockNumber: batch.checkpoint.blockNumber,
        blockHash: batch.checkpoint.blockHash,
        updatedAt: new Date().toISOString(),
      });
    },

    async rewindTo(chainId, blockNumber, blockHash) {
      for (const [key, d] of deployments.entries()) {
        if (d.chainId === chainId && d.blockNumber > blockNumber) {
          deployments.delete(key);
        }
      }
      for (let i = classChanges.length - 1; i >= 0; i--) {
        if (
          classChanges[i].chainId === chainId &&
          classChanges[i].blockNumber > blockNumber
        ) {
          classChanges.splice(i, 1);
        }
      }
      for (const [key, em] of eventEmitters.entries()) {
        if (em.chainId === chainId && em.firstSeenBlock > blockNumber) {
          eventEmitters.delete(key);
        }
      }
      if (blockNumber >= 0 && blockHash) {
        checkpoints.set(chainId, {
          chainId,
          blockNumber,
          blockHash,
          updatedAt: new Date().toISOString(),
        });
      } else {
        checkpoints.delete(chainId);
      }
    },

    async recordRpcProbe(chainId, probe) {
      rpcProbes.push({ id: rpcProbes.length + 1, chainId, ...probe });
    },

    async getDeployment(chainId, contractAddress) {
      const d = deployments.get(`${chainId}:${contractAddress}`);
      return d ? { ...d } : null;
    },

    async getClassHistory(chainId, contractAddress) {
      return classChanges
        .filter(
          (c) =>
            c.chainId === chainId && c.contractAddress === contractAddress,
        )
        .sort((a, b) => a.blockNumber - b.blockNumber || a.id - b.id)
        .map((c) => ({ ...c }));
    },

    _state: { checkpoints, deployments, classChanges, eventEmitters, rpcProbes },
  };
}

