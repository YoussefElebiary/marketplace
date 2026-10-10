/**
 * PostgreSQL store for contract discovery results.
 *
 * Provides atomic commit of discoveries alongside checkpoints, rewind
 * support for reorg handling, and RPC probe recording. All writes use
 * parameterised queries to prevent injection.
 *
 * @module discovery-store
 */

/**
 * Create a discovery store backed by a PostgreSQL connection pool.
 *
 * @param {import("pg").Pool} pool
 * @returns {object} store with getCheckpoint, commitDiscoveries, rewindTo, recordRpcProbe, getDeployment, getClassHistory
 */
export function createDiscoveryStore(pool) {
  return {
    /**
     * Retrieve the last committed discovery checkpoint for a chain.
     *
     * @param {string} chainId
     * @returns {Promise<{ chainId: string, blockNumber: number, blockHash: string } | null>}
     */
    async getCheckpoint(chainId) {
      const { rows } = await pool.query(
        `SELECT chain_id, block_number, block_hash
           FROM chain.discovery_checkpoints
          WHERE chain_id = $1`,
        [chainId],
      );
      if (!rows.length) return null;
      return {
        chainId: rows[0].chain_id,
        blockNumber: Number(rows[0].block_number),
        blockHash: rows[0].block_hash,
      };
    },

    /**
     * Commit a batch of discoveries atomically with a checkpoint update.
     * Deployments use INSERT ... ON CONFLICT DO NOTHING to stay idempotent.
     *
     * @param {object} batch
     * @param {string} batch.chainId
     * @param {object[]} batch.deployments
     * @param {object[]} batch.classChanges
     * @param {string[]} batch.eventEmitters
     * @param {{ chainId: string, blockNumber: number, blockHash: string }} batch.checkpoint
     */
    async commitDiscoveries(batch) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // ── Deployments (idempotent via ON CONFLICT) ──
        for (const d of batch.deployments) {
          await client.query(
            `INSERT INTO chain.discovered_deployments
               (chain_id, contract_address, class_hash, deployer_address,
                block_number, block_hash, transaction_hash, transaction_index,
                deploy_type, constructor_calldata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (chain_id, contract_address) DO NOTHING`,
            [
              batch.chainId,
              d.contractAddress,
              d.classHash,
              d.deployerAddress,
              d.blockNumber,
              d.blockHash,
              d.transactionHash,
              d.transactionIndex,
              d.deployType,
              JSON.stringify(d.constructorCalldata ?? []),
            ],
          );
        }

        // ── Class changes ──
        for (const cc of batch.classChanges) {
          await client.query(
            `INSERT INTO chain.class_changes
               (chain_id, contract_address, previous_class_hash, new_class_hash,
                block_number, block_hash, transaction_hash, event_index,
                change_type)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              batch.chainId,
              cc.contractAddress,
              cc.previousClassHash,
              cc.newClassHash,
              cc.blockNumber,
              cc.blockHash,
              cc.transactionHash,
              cc.eventIndex,
              cc.changeType,
            ],
          );
        }

        // ── Event emitter candidates (upsert) ──
        for (const addr of batch.eventEmitters) {
          await client.query(
            `INSERT INTO chain.event_emitter_candidates
               (chain_id, contract_address, first_seen_block, last_seen_block, event_count)
             VALUES ($1, $2, $3, $3, 1)
             ON CONFLICT (chain_id, contract_address)
             DO UPDATE SET
               last_seen_block = GREATEST(
                 chain.event_emitter_candidates.last_seen_block, EXCLUDED.last_seen_block),
               event_count = chain.event_emitter_candidates.event_count + 1`,
            [batch.chainId, addr, batch.checkpoint.blockNumber],
          );
        }

        // ── Checkpoint (atomic with discoveries) ──
        await client.query(
          `INSERT INTO chain.discovery_checkpoints
             (chain_id, block_number, block_hash, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (chain_id)
           DO UPDATE SET
             block_number = EXCLUDED.block_number,
             block_hash   = EXCLUDED.block_hash,
             updated_at   = now()`,
          [
            batch.checkpoint.chainId,
            batch.checkpoint.blockNumber,
            batch.checkpoint.blockHash,
          ],
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    /**
     * Rewind discovery state to a given block height, removing all
     * discoveries and checkpoints above that height. Used for reorg
     * handling — invalidates dependent classification data.
     *
     * @param {string} chainId
     * @param {number} blockNumber - rewind target (inclusive)
     * @param {string | null} blockHash
     */
    async rewindTo(chainId, blockNumber, blockHash) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `DELETE FROM chain.discovered_deployments
            WHERE chain_id = $1 AND block_number > $2`,
          [chainId, blockNumber],
        );

        await client.query(
          `DELETE FROM chain.class_changes
            WHERE chain_id = $1 AND block_number > $2`,
          [chainId, blockNumber],
        );

        await client.query(
          `DELETE FROM chain.event_emitter_candidates
            WHERE chain_id = $1 AND first_seen_block > $2`,
          [chainId, blockNumber],
        );

        if (blockNumber >= 0 && blockHash) {
          await client.query(
            `INSERT INTO chain.discovery_checkpoints
               (chain_id, block_number, block_hash, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (chain_id)
             DO UPDATE SET
               block_number = EXCLUDED.block_number,
               block_hash   = EXCLUDED.block_hash,
               updated_at   = now()`,
            [chainId, blockNumber, blockHash],
          );
        } else {
          await client.query(
            `DELETE FROM chain.discovery_checkpoints WHERE chain_id = $1`,
            [chainId],
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    /**
     * Record an RPC capability probe result.
     *
     * @param {string} chainId
     * @param {object} probe
     */
    async recordRpcProbe(chainId, probe) {
      await pool.query(
        `INSERT INTO chain.rpc_probes
           (chain_id, probe_time, earliest_available_block, latest_block,
            supports_get_block_with_receipts, supports_get_events,
            supports_get_class_hash_at, gaps, errors)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          chainId,
          probe.probeTime,
          probe.earliestAvailableBlock,
          probe.latestBlock,
          probe.supportsGetBlockWithReceipts,
          probe.supportsGetEvents,
          probe.supportsGetClassHashAt,
          JSON.stringify(probe.gaps ?? []),
          JSON.stringify(probe.errors ?? []),
        ],
      );
    },

    /**
     * Get the deployment record for a specific contract address.
     *
     * @param {string} chainId
     * @param {string} contractAddress
     * @returns {Promise<object | null>}
     */
    async getDeployment(chainId, contractAddress) {
      const { rows } = await pool.query(
        `SELECT * FROM chain.discovered_deployments
          WHERE chain_id = $1 AND contract_address = $2`,
        [chainId, contractAddress],
      );
      return rows[0] ?? null;
    },

    /**
     * Get the full class change history for a contract address,
     * ordered by block number ascending.
     *
     * @param {string} chainId
     * @param {string} contractAddress
     * @returns {Promise<object[]>}
     */
    async getClassHistory(chainId, contractAddress) {
      const { rows } = await pool.query(
        `SELECT * FROM chain.class_changes
          WHERE chain_id = $1 AND contract_address = $2
          ORDER BY block_number ASC, id ASC`,
        [chainId, contractAddress],
      );
      return rows;
    },
  };
}
