// LOCAL PATCH (Cloudflare port): store partitioning is a Cloudflare-deployment
// concern — upstream serves from Postgres and has no partition axis — so this
// module never goes upstream. It exists here, inside the engine crate, because
// the builder must assign every card to its partition and the TypeScript router
// must compute the same assignment from the same oracle_id, and the two
// implementations are held together by tests/engine/partition-hash-vectors.json
// in the deployment repo (a third, hand-generated source both sides assert
// against). If this function and src/engine/partition.ts ever disagree, the
// router asks the wrong partition and cards silently vanish from results —
// CARD-PARTITIONING.md calls this the highest-consequence detail in the design.

/// FNV-1a 64-bit over the ASCII bytes of the canonical lowercase hyphenated
/// oracle_id string. The input is lowercased defensively; Scryfall already
/// serves oracle_ids lowercase, but a stray uppercase hex digit must not move a
/// card to a different partition.
pub fn fnv1a64_oracle_id(oracle_id: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in oracle_id.bytes() {
        hash ^= byte.to_ascii_lowercase() as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The partition owning `oracle_id` when the store is cut into
/// `partition_count` partitions. `partition_count` comes from the build (and
/// reaches readers via the manifest) — it is never a constant.
pub fn partition_of_oracle_id(oracle_id: &str, partition_count: u32) -> u32 {
    debug_assert!(partition_count > 0, "partition_count must be positive");
    (fnv1a64_oracle_id(oracle_id) % u64::from(partition_count)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared vector file lives in the deployment repo so the bun test and
    /// this test read the same bytes; drift between the two implementations is
    /// unrepresentable as long as both suites run.
    const VECTORS: &str = include_str!("../../../../tests/engine/partition-hash-vectors.json");

    #[test]
    fn hash_matches_shared_vectors() {
        let parsed: serde_json::Value = serde_json::from_str(VECTORS).expect("vector file parses");
        assert_eq!(
            parsed["algorithm"].as_str(),
            Some("fnv1a64/oracle_id/v1"),
            "algorithm name changed without a new vector set"
        );
        let vectors = parsed["vectors"].as_array().expect("vectors array");
        assert!(vectors.len() >= 32, "vector set too small to trust");
        for v in vectors {
            let oracle_id = v["oracle_id"].as_str().expect("oracle_id");
            let expected: u64 = v["fnv1a64"]
                .as_str()
                .expect("fnv1a64 as decimal string")
                .parse()
                .expect("fnv1a64 parses as u64");
            assert_eq!(
                fnv1a64_oracle_id(oracle_id),
                expected,
                "hash mismatch for {oracle_id}"
            );
        }
    }

    #[test]
    fn uppercase_input_lands_in_the_same_partition() {
        let id = "5963eef1-1022-42b1-8a0c-fc9850bfc2a3";
        assert_eq!(
            fnv1a64_oracle_id(id),
            fnv1a64_oracle_id(&id.to_ascii_uppercase())
        );
    }

    #[test]
    fn every_residue_is_reachable_at_eight() {
        let parsed: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let mut seen = [false; 8];
        for v in parsed["vectors"].as_array().unwrap() {
            let oracle_id = v["oracle_id"].as_str().unwrap();
            seen[partition_of_oracle_id(oracle_id, 8) as usize] = true;
        }
        assert!(seen.iter().all(|s| *s), "vector set misses a residue at N=8");
    }
}
