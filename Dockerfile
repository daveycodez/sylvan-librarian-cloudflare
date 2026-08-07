# Import container: builds the card-engine store from Scryfall bulk data and
# uploads it to R2. Started on demand by the ImportCoordinator Durable Object
# (nightly cron + first-deploy bootstrap); it runs one import, then exits.
#
# Workers Builds builds this image when the repo deploys — no local Docker needed.

FROM rust:1.88-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml ./
COPY vendor/sylvan_librarian/card_engine ./vendor/sylvan_librarian/card_engine
COPY engine ./engine
# The workspace lists engine/wasm, which needs no compiling here; build only the builder.
# -A dead_code: the vendored card_engine carries python-feature-only diagnostics
# that are (correctly) dead in this build; keep deploy logs readable without
# patching vendor code. Local `cargo build` still surfaces the warnings.
RUN RUSTFLAGS="-A dead_code" cargo build --release -p sylvan-store-builder

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/sylvan-store-builder /usr/local/bin/sylvan-store-builder
# The builder reads R2_* / CF_ACCOUNT_ID / R2_BUCKET from env (passed by the DO)
# and serves progress on :8080 so the coordinator can stream status.
EXPOSE 8080
CMD ["sylvan-store-builder", "--serve"]
