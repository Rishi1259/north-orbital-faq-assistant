# MinIO community is now source-only; build pinned upstream releases instead of
# relying on unavailable Docker Hub/Quay images. Used for local development only.
FROM golang:1.25-bookworm AS server-build
RUN CGO_ENABLED=0 go install github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z

FROM golang:1.25-bookworm AS client-build
RUN CGO_ENABLED=0 go install github.com/minio/mc@RELEASE.2025-08-13T08-35-41Z

FROM debian:bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

FROM base AS minio
COPY --from=server-build /go/bin/minio /usr/local/bin/minio
ENTRYPOINT ["minio"]

FROM base AS mc
COPY --from=client-build /go/bin/mc /usr/local/bin/mc
ENTRYPOINT ["mc"]
