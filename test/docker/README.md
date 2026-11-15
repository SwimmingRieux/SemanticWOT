# Controlled Docker acceptance

Run `npm ci` and `npm run test:docker` from the repository root with Node 24+,
Docker Engine/Desktop and Compose installed. No real provider credentials or models
are used. This is an opt-in infrastructure test separate from unit/integration
checks; it builds the real Docker image with `--no-cache`, starts the real Compose
service, and drives the shipped HTTP interface. It needs permission to bind host
fixture ports on all interfaces so the app container can reach them through
`host.docker.internal`. Do not run fixture services on a public unprotected host.

The test gives genuinely signed fixture events the current host timestamp (the
production app keeps its real clock). Reusable service helpers otherwise retain
their deterministic browser defaults. Both Ollama and OpenAI HTTP paths exercise
first feed, saved revisit without collection, explicit refresh with compatible
embedding reuse, and restart durability of the library cache and saved-feed store.
The final image loads native SQLite independently of host modules. The check also
resolves the packaged provider examples (including the effective single nos.lol
list and 20/20/20 caps) and audits the exact allowlisted Docker build context.
For a repeat check after an already verified clean build, set
`DOCKER_ACCEPTANCE_BUILD_CACHE=1` to permit Docker layer reuse. Dummy secrets
are checked against logs and the isolated persistent data directory.

Each run owns uniquely named Compose projects, images and volumes. Cleanup removes
only those resources, including its disposable test data; existing Docker services
are untouched. Build cache/base images may remain for Docker's normal management.
A host Docker restart or global prune is never required. See `docs/docker.md` for
the operator workflow and platform limits.
