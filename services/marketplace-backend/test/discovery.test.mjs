import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDiscoveries,
  discoverRange,
  resumeDiscovery,
  handleReorg,
  probeRpcCapabilities,
  normalizeAddress,
  feltEqual,
  createMemoryDiscoveryStore,
  UDC_ADDRESS,
  CONTRACT_DEPLOYED_KEY,
  UPGRADED_KEY,
} from "../src/discovery.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DUMMY_CHAIN_ID = "SN_MAIN";

const SAMPLE_CLASS_HASH_1 =
  "0x042731c2355af9d59eda314ea3cca49ea3cc85173b2ca3c35c6c9df1c087cc43";
const SAMPLE_CLASS_HASH_2 =
  "0x0181c70595dd7db697c37ceb35c74fab69a037836b99cc80c17fd92a16289e26";
const SAMPLE_DEPLOYER =
  "0x021b3456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SAMPLE_CONTRACT_ADDR =
  "0x0572fe34a769058c62a66f0c4854d08ccfd21fcbb4f0b1685a1868b84c6ee266";

function makeBlock(number, hash, transactions = []) {
  return {
    block_number: number,
    block_hash: hash,
    parent_hash: `0xparent_${number}`,
    status: "ACCEPTED_ON_L2",
    transactions,
  };
}

// ─── Unit Tests: extractDiscoveries ───────────────────────────────────────────

test("extractDiscoveries: extracts legacy DEPLOY transactions with full provenance", () => {
  const block = makeBlock(100, "0xhash100", [
    {
      transaction: {
        type: "DEPLOY",
        transaction_hash: "0xtx1",
        contract_address: SAMPLE_CONTRACT_ADDR,
        class_hash: SAMPLE_CLASS_HASH_1,
        constructor_calldata: ["0x1", "0x2"],
      },
      receipt: {
        transaction_hash: "0xtx1",
        execution_status: "SUCCEEDED",
        events: [],
      },
    },
  ]);

  const { deployments, classChanges, eventEmitters } = extractDiscoveries(block);

  assert.equal(deployments.length, 1);
  assert.equal(deployments[0].contractAddress, normalizeAddress(SAMPLE_CONTRACT_ADDR));
  assert.equal(deployments[0].classHash, normalizeAddress(SAMPLE_CLASS_HASH_1));
  assert.equal(deployments[0].blockNumber, 100);
  assert.equal(deployments[0].blockHash, "0xhash100");
  assert.equal(deployments[0].transactionHash, "0xtx1");
  assert.equal(deployments[0].transactionIndex, 0);
  assert.equal(deployments[0].deployType, "deploy_txn");
  assert.deepEqual(deployments[0].constructorCalldata, ["0x1", "0x2"]);

  assert.equal(classChanges.length, 1);
  assert.equal(classChanges[0].contractAddress, normalizeAddress(SAMPLE_CONTRACT_ADDR));
  assert.equal(classChanges[0].newClassHash, normalizeAddress(SAMPLE_CLASS_HASH_1));
  assert.equal(classChanges[0].changeType, "deploy");
  assert.equal(eventEmitters.size, 0);
});

test("extractDiscoveries: extracts DEPLOY_ACCOUNT transactions", () => {
  const accountAddr = "0x0111222333444555666777888999aaabbbcccdddeeefff";
  const block = makeBlock(101, "0xhash101", [
    {
      transaction: {
        type: "DEPLOY_ACCOUNT",
        transaction_hash: "0xtx_acc",
        sender_address: accountAddr,
        class_hash: SAMPLE_CLASS_HASH_1,
        constructor_calldata: ["0xpublic_key"],
      },
      receipt: {
        transaction_hash: "0xtx_acc",
        execution_status: "SUCCEEDED",
        contract_address: accountAddr,
        events: [],
      },
    },
  ]);

  const { deployments, classChanges } = extractDiscoveries(block);
  assert.equal(deployments.length, 1);
  assert.equal(deployments[0].contractAddress, normalizeAddress(accountAddr));
  assert.equal(deployments[0].deployType, "deploy_account_txn");
  assert.equal(classChanges.length, 1);
  assert.equal(classChanges[0].changeType, "deploy");
});

test("extractDiscoveries: extracts UDC ContractDeployed events with constructor calldata and deployer", () => {
  const deployedContract = "0x0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba";
  const block = makeBlock(200, "0xhash200", [
    {
      transaction: {
        type: "INVOKE_FUNCTION",
        transaction_hash: "0xtx_udc",
      },
      receipt: {
        transaction_hash: "0xtx_udc",
        execution_status: "SUCCEEDED",
        events: [
          {
            from_address: UDC_ADDRESS,
            keys: [CONTRACT_DEPLOYED_KEY],
            // data: [address, deployer, unique, classHash, calldata_len, ...calldata, salt]
            data: [
              deployedContract,
              SAMPLE_DEPLOYER,
              "0x0",
              SAMPLE_CLASS_HASH_1,
              "0x2",
              "0x111",
              "0x222",
              "0xsalt123",
            ],
          },
        ],
      },
    },
  ]);

  const { deployments, classChanges, eventEmitters } = extractDiscoveries(block);

  assert.equal(deployments.length, 1);
  assert.equal(deployments[0].contractAddress, normalizeAddress(deployedContract));
  assert.equal(deployments[0].deployerAddress, normalizeAddress(SAMPLE_DEPLOYER));
  assert.equal(deployments[0].classHash, normalizeAddress(SAMPLE_CLASS_HASH_1));
  assert.equal(deployments[0].deployType, "udc");
  assert.deepEqual(deployments[0].constructorCalldata, ["0x111", "0x222"]);

  assert.equal(classChanges.length, 1);
  assert.equal(classChanges[0].contractAddress, normalizeAddress(deployedContract));
  assert.equal(classChanges[0].newClassHash, normalizeAddress(SAMPLE_CLASS_HASH_1));
  assert.equal(classChanges[0].eventIndex, 0);

  assert.ok(eventEmitters.has(normalizeAddress(UDC_ADDRESS)));
});

test("extractDiscoveries: extracts Cairo 0 and Cairo 1 Upgraded events", () => {
  const contract1 = "0x0111111111111111111111111111111111111111111111111111111111111111";
  const contract2 = "0x0222222222222222222222222222222222222222222222222222222222222222";

  const block = makeBlock(300, "0xhash300", [
    {
      transaction: {
        type: "INVOKE_FUNCTION",
        transaction_hash: "0xtx_upgrade",
      },
      receipt: {
        transaction_hash: "0xtx_upgrade",
        execution_status: "SUCCEEDED",
        events: [
          // Cairo 0 Upgraded event: single key = UPGRADED_KEY
          {
            from_address: contract1,
            keys: [UPGRADED_KEY],
            data: [SAMPLE_CLASS_HASH_2],
          },
          // Cairo 1 Component Upgraded event: multiple keys [component_selector, UPGRADED_KEY]
          {
            from_address: contract2,
            keys: ["0x1234abcd", UPGRADED_KEY],
            data: [SAMPLE_CLASS_HASH_1],
          },
        ],
      },
    },
  ]);

  const { deployments, classChanges } = extractDiscoveries(block);

  assert.equal(deployments.length, 0); // Upgrades are not deployments
  assert.equal(classChanges.length, 2);

  assert.equal(classChanges[0].contractAddress, normalizeAddress(contract1));
  assert.equal(classChanges[0].newClassHash, normalizeAddress(SAMPLE_CLASS_HASH_2));
  assert.equal(classChanges[0].changeType, "upgrade");
  assert.equal(classChanges[0].eventIndex, 0);

  assert.equal(classChanges[1].contractAddress, normalizeAddress(contract2));
  assert.equal(classChanges[1].newClassHash, normalizeAddress(SAMPLE_CLASS_HASH_1));
  assert.equal(classChanges[1].changeType, "upgrade");
  assert.equal(classChanges[1].eventIndex, 1);
});

test("extractDiscoveries: ignores reverted transactions", () => {
  const block = makeBlock(400, "0xhash400", [
    {
      transaction: {
        type: "DEPLOY",
        transaction_hash: "0xtx_reverted",
        contract_address: SAMPLE_CONTRACT_ADDR,
        class_hash: SAMPLE_CLASS_HASH_1,
      },
      receipt: {
        transaction_hash: "0xtx_reverted",
        execution_status: "REVERTED",
        revert_error: "Out of gas",
        events: [],
      },
    },
  ]);

  const { deployments, classChanges, eventEmitters } = extractDiscoveries(block);
  assert.equal(deployments.length, 0);
  assert.equal(classChanges.length, 0);
  assert.equal(eventEmitters.size, 0);
});

test("extractDiscoveries: handles empty blocks cleanly", () => {
  const block = makeBlock(500, "0xhash500", []);
  const { deployments, classChanges, eventEmitters } = extractDiscoveries(block);
  assert.equal(deployments.length, 0);
  assert.equal(classChanges.length, 0);
  assert.equal(eventEmitters.size, 0);
});

// ─── Range Scanner & Resume Tests ─────────────────────────────────────────────

test("discoverRange: commits discoveries atomically with checkpoint", async () => {
  const store = createMemoryDiscoveryStore();

  const mockBlocks = new Map([
    [
      10,
      makeBlock(10, "0xhash10", [
        {
          transaction: {
            type: "DEPLOY",
            transaction_hash: "0xtx10",
            contract_address: SAMPLE_CONTRACT_ADDR,
            class_hash: SAMPLE_CLASS_HASH_1,
          },
          receipt: {
            transaction_hash: "0xtx10",
            execution_status: "SUCCEEDED",
            events: [],
          },
        },
      ]),
    ],
    [11, makeBlock(11, "0xhash11", [])],
  ]);

  const rpc = {
    call: async (method, params) => {
      if (method === "starknet_getBlockWithReceipts") {
        return mockBlocks.get(params.block_id.block_number);
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };

  const result = await discoverRange(rpc, store, DUMMY_CHAIN_ID, 10, 11, {
    batchSize: 5,
  });

  assert.equal(result.blocksScanned, 2);
  assert.equal(result.totalDeployments, 1);

  // Verify checkpoint matches the end block
  const cp = await store.getCheckpoint(DUMMY_CHAIN_ID);
  assert.ok(cp);
  assert.equal(cp.blockNumber, 11);
  assert.equal(cp.blockHash, "0xhash11");

  // Verify discovered deployment exists
  const deployment = await store.getDeployment(
    DUMMY_CHAIN_ID,
    normalizeAddress(SAMPLE_CONTRACT_ADDR),
  );
  assert.ok(deployment);
  assert.equal(deployment.blockNumber, 10);
});

test("discoverRange: idempotent on duplicate execution", async () => {
  const store = createMemoryDiscoveryStore();

  const mockBlock = makeBlock(20, "0xhash20", [
    {
      transaction: {
        type: "DEPLOY",
        transaction_hash: "0xtx20",
        contract_address: SAMPLE_CONTRACT_ADDR,
        class_hash: SAMPLE_CLASS_HASH_1,
      },
      receipt: {
        transaction_hash: "0xtx20",
        execution_status: "SUCCEEDED",
        events: [],
      },
    },
  ]);

  const rpc = {
    call: async (method) => {
      if (method === "starknet_getBlockWithReceipts") return mockBlock;
      throw new Error("unexpected");
    },
  };

  // Run first time
  await discoverRange(rpc, store, DUMMY_CHAIN_ID, 20, 20);
  // Run second time (re-scan duplicate block)
  await discoverRange(rpc, store, DUMMY_CHAIN_ID, 20, 20);

  // Deployments map should only contain one entry for the contract address
  assert.equal(store._state.deployments.size, 1);
});

test("resumeDiscovery: picks up after existing checkpoint", async () => {
  const store = createMemoryDiscoveryStore();

  // Manually pre-seed checkpoint at block 50
  await store.commitDiscoveries({
    chainId: DUMMY_CHAIN_ID,
    deployments: [],
    classChanges: [],
    eventEmitters: [],
    checkpoint: {
      chainId: DUMMY_CHAIN_ID,
      blockNumber: 50,
      blockHash: "0xhash50",
    },
  });

  const requestedBlocks = [];
  const rpc = {
    call: async (method, params) => {
      if (method === "starknet_blockNumber") return 52;
      if (method === "starknet_getBlockWithReceipts") {
        const bn = params.block_id.block_number;
        requestedBlocks.push(bn);
        return makeBlock(bn, `0xhash${bn}`, []);
      }
      throw new Error("unexpected");
    },
  };

  const result = await resumeDiscovery(rpc, store, DUMMY_CHAIN_ID);
  assert.equal(result.from, 51); // 50 + 1
  assert.equal(result.to, 52);
  assert.deepEqual(requestedBlocks, [51, 52]);

  const cp = await store.getCheckpoint(DUMMY_CHAIN_ID);
  assert.equal(cp.blockNumber, 52);
});

// ─── Reorg Handling Tests ─────────────────────────────────────────────────────

test("handleReorg: detects reorg and rewinds discoveries to canonical ancestor", async () => {
  const store = createMemoryDiscoveryStore();

  // Seed checkpoint at block 100 with old fork hash
  await store.commitDiscoveries({
    chainId: DUMMY_CHAIN_ID,
    deployments: [
      {
        contractAddress: "0xaddr_fork",
        classHash: SAMPLE_CLASS_HASH_1,
        blockNumber: 100,
        blockHash: "0xold_fork_hash",
        transactionHash: "0xtx_fork",
        transactionIndex: 0,
        deployType: "deploy_txn",
      },
      {
        contractAddress: "0xaddr_common",
        classHash: SAMPLE_CLASS_HASH_1,
        blockNumber: 99,
        blockHash: "0xcanonical_99",
        transactionHash: "0xtx_common",
        transactionIndex: 0,
        deployType: "deploy_txn",
      },
    ],
    classChanges: [
      {
        contractAddress: "0xaddr_fork",
        newClassHash: SAMPLE_CLASS_HASH_1,
        blockNumber: 100,
        blockHash: "0xold_fork_hash",
        transactionHash: "0xtx_fork",
        changeType: "deploy",
      },
      {
        contractAddress: "0xaddr_common",
        newClassHash: SAMPLE_CLASS_HASH_1,
        blockNumber: 99,
        blockHash: "0xcanonical_99",
        transactionHash: "0xtx_common",
        changeType: "deploy",
      },
    ],
    eventEmitters: ["0xaddr_fork", "0xaddr_common"],
    checkpoint: {
      chainId: DUMMY_CHAIN_ID,
      blockNumber: 100,
      blockHash: "0xold_fork_hash",
    },
  });

  const rpc = {
    call: async (method, params) => {
      if (method === "starknet_getBlockWithTxHashes") {
        const bn = params.block_id.block_number;
        if (bn === 100) {
          // Block 100 is on a different fork!
          return { block_number: 100, block_hash: "0xnew_canonical_100" };
        }
        if (bn === 99) {
          // Block 99 matches the common ancestor
          return { block_number: 99, block_hash: "0xcanonical_99" };
        }
      }
      throw new Error(`Unexpected ${method}`);
    },
  };

  const reorgResult = await handleReorg(rpc, store, DUMMY_CHAIN_ID);
  assert.equal(reorgResult.reorged, true);
  assert.equal(reorgResult.rewindTo, 99);

  // Block 100 deployment must have been pruned
  const forkDeploy = await store.getDeployment(DUMMY_CHAIN_ID, "0xaddr_fork");
  assert.equal(forkDeploy, null);

  // Block 99 deployment must be preserved
  const commonDeploy = await store.getDeployment(DUMMY_CHAIN_ID, "0xaddr_common");
  assert.ok(commonDeploy);

  // Checkpoint must be rewound to 99
  const cp = await store.getCheckpoint(DUMMY_CHAIN_ID);
  assert.equal(cp.blockNumber, 99);
  assert.equal(cp.blockHash, "0xcanonical_99");
});

test("handleReorg: returns reorged=false when canonical hash matches", async () => {
  const store = createMemoryDiscoveryStore();
  await store.commitDiscoveries({
    chainId: DUMMY_CHAIN_ID,
    deployments: [],
    classChanges: [],
    eventEmitters: [],
    checkpoint: {
      chainId: DUMMY_CHAIN_ID,
      blockNumber: 150,
      blockHash: "0xcanonical_150",
    },
  });

  const rpc = {
    call: async (method, params) => {
      if (method === "starknet_getBlockWithTxHashes") {
        return { block_number: 150, block_hash: "0xcanonical_150" };
      }
      throw new Error("unexpected");
    },
  };

  const reorgResult = await handleReorg(rpc, store, DUMMY_CHAIN_ID);
  assert.equal(reorgResult.reorged, false);
});

// ─── RPC Capability Probe Tests ───────────────────────────────────────────────

test("probeRpcCapabilities: detects capabilities and finds earliest available block", async () => {
  const rpc = {
    call: async (method, params) => {
      if (method === "starknet_blockNumber") return 1000;
      if (method === "starknet_getBlockWithReceipts") return {};
      if (method === "starknet_getEvents") return { events: [] };
      if (method === "starknet_getBlockWithTxHashes") {
        const bn = params.block_id.block_number;
        // Blocks before 500 return Block not found (pruned / archive limit)
        if (bn < 500) {
          const err = new Error("Block not found");
          err.code = 24;
          throw err;
        }
        return { block_number: bn, block_hash: `0xhash${bn}` };
      }
      throw new Error(`Unexpected ${method}`);
    },
  };

  const probe = await probeRpcCapabilities(rpc);
  assert.equal(probe.latestBlock, 1000);
  assert.equal(probe.earliestAvailableBlock, 500);
  assert.equal(probe.supportsGetBlockWithReceipts, true);
  assert.equal(probe.supportsGetEvents, true);
  assert.equal(probe.errors.length, 0);
});

test("probeRpcCapabilities: records unsupported methods honestly", async () => {
  const rpc = {
    call: async (method) => {
      if (method === "starknet_blockNumber") return 50;
      if (method === "starknet_getBlockWithReceipts") {
        const err = new Error("Method not found");
        err.code = -32601;
        throw err;
      }
      if (method === "starknet_getEvents") return { events: [] };
      if (method === "starknet_getBlockWithTxHashes") return {};
      throw new Error("unexpected");
    },
  };

  const probe = await probeRpcCapabilities(rpc);
  assert.equal(probe.supportsGetBlockWithReceipts, false);
  assert.equal(probe.supportsGetEvents, true);
  assert.ok(probe.errors.some((e) => e.method === "starknet_getBlockWithReceipts"));
});

// ─── Benchmark: Historical Acquisition Performance ────────────────────────────

test("benchmark: historical acquisition measures throughput and finishes within budget", async () => {
  const store = createMemoryDiscoveryStore();
  const NUM_BLOCKS = 100;

  // Generate synthetic history with occasional deployments and upgrades
  const syntheticHistory = new Map();
  for (let n = 0; n < NUM_BLOCKS; n++) {
    const txs = [];
    if (n % 5 === 0) {
      txs.push({
        transaction: {
          type: "INVOKE_FUNCTION",
          transaction_hash: `0x${(0xaa0000 + n).toString(16)}`,
        },
        receipt: {
          transaction_hash: `0x${(0xaa0000 + n).toString(16)}`,
          execution_status: "SUCCEEDED",
          events: [
            {
              from_address: UDC_ADDRESS,
              keys: [CONTRACT_DEPLOYED_KEY],
              data: [
                `0x${(0x1000 + n).toString(16)}`,
                SAMPLE_DEPLOYER,
                "0x0",
                SAMPLE_CLASS_HASH_1,
                "0x0",
                `0x${n.toString(16)}`,
              ],
            },
          ],
        },
      });
    }
    if (n % 10 === 5) {
      txs.push({
        transaction: {
          type: "INVOKE_FUNCTION",
          transaction_hash: `0x${(0xbb0000 + n).toString(16)}`,
        },
        receipt: {
          transaction_hash: `0x${(0xbb0000 + n).toString(16)}`,
          execution_status: "SUCCEEDED",
          events: [
            {
              from_address: `0x${(0x1000 + n).toString(16)}`,
              keys: [UPGRADED_KEY],
              data: [SAMPLE_CLASS_HASH_2],
            },
          ],
        },
      });
    }
    syntheticHistory.set(n, makeBlock(n, `0x${(0x100000 + n).toString(16)}`, txs));
  }

  const rpc = {
    call: async (method, params) => {
      if (method === "starknet_getBlockWithReceipts") {
        return syntheticHistory.get(params.block_id.block_number);
      }
      throw new Error("unexpected");
    },
  };

  const t0 = performance.now();
  const summary = await discoverRange(rpc, store, DUMMY_CHAIN_ID, 0, NUM_BLOCKS - 1, {
    batchSize: 25,
  });
  const elapsedMs = performance.now() - t0;

  assert.equal(summary.blocksScanned, NUM_BLOCKS);
  assert.equal(summary.totalDeployments, 20); // every 5 blocks: n = 0, 5, 10 ... 95
  assert.equal(summary.totalClassChanges, 30); // 20 deployments + 10 upgrades (n = 5, 15, ..., 95)

  const blocksPerSec = Math.round((NUM_BLOCKS * 1000) / elapsedMs);
  // Historical acquisition benchmark: must achieve > 200 blocks/sec for synthetic in-memory batches
  assert.ok(
    blocksPerSec > 200,
    `Historical acquisition benchmark: expected >200 blocks/sec, got ${blocksPerSec} blocks/sec (${elapsedMs.toFixed(1)}ms for ${NUM_BLOCKS} blocks)`,
  );
});
