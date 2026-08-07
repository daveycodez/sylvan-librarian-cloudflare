# Import container: builds the card-engine store from Scryfall bulk data and
# uploads it to R2. Started on demand by the ImportCoordinator Durable Object
# (nightly cron + first-deploy bootstrap); it runs one import, then exits.
#
# Workers Builds builds this image on every deploy with no persisted Docker
# layer cache, so build time = deploy time. Kept lean deliberately:
#   - `container` cargo profile (no LTO): the binary is a network-bound batch
#     job; fat LTO would dominate CI time for no measurable runtime win.
#   - no apt in the build stage: the dependency tree is rustls-only (zero
#     openssl in Cargo.lock) and rust:slim already ships ca-certificates.
#   - distroless runtime: CA certs + glibc included, no apt step, tiny image.

FROM rust:1.88-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY vendor/sylvan_librarian/card_engine ./vendor/sylvan_librarian/card_engine
COPY engine ./engine
# --locked: build exactly the dependency versions tested locally (without the
# lockfile, CI re-resolved all deps fresh on every deploy — irreproducible and
# slower). -A dead_code: the vendored card_engine carries python-feature-only
# diagnostics that are (correctly) dead in this build; keep deploy logs
# readable without patching vendor code. Local builds still show the warnings.
RUN RUSTFLAGS="-A dead_code" cargo build --locked --profile container -p sylvan-store-builder

FROM gcr.io/distroless/cc-debian12
COPY --from=build /app/target/container/sylvan-store-builder /usr/local/bin/sylvan-store-builder
# The builder reads R2_* / CF_ACCOUNT_ID / R2_BUCKET from env (passed by the DO)
# and serves progress on :8080 so the coordinator can stream status.
EXPOSE 8080
CMD ["sylvan-store-builder", "--serve"]
