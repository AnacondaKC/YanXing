# P5 isolated container acceptance

This path is **not a formal cutover**. The final sealed candidate is `out/p5-verified-candidate`; the selected isolated image is `yanxing:p5-qa-verified`, never `latest`. Exact BUILD_ID, hashes and all acceptance evidence are in [the P5 record](project-stage-report-p5-acceptance.md). Earlier interim/final candidates are retained but are not the final sealed artifact.

## Reproduce

```bash
node scripts/p5-package.mjs --destination /absolute/NEW-candidate
node scripts/p5-package-container.mjs --candidate-root /absolute/NEW-candidate --image-tag yanxing:UNIQUE-QA-TAG --report-path /absolute/NEW-report.json
```

- Destination must be absolute and absent, including empty directories. The isolated assembler refuses the project root, .docker-runtime, storage, test and protected data paths.
- The build config is generated only inside the candidate; root .docker-build.json and .docker-runtime are untouched.
- Next distDir is .next-p5-qa; static assets stay under the matching directory. Worker, parsers and management commands come from the same .runtime manifest.
- Runtime tracing excludes previous .next*/out candidates, compilers and .settings-key. The sealed runtime manifest has1159 entries.
- No host .env, live storage or paid model credentials enter the candidate/container. Tests use synthetic keys and private roots.

## Verified boundaries

- Default supervisor, Web and Worker run as UID1000 with a read-only root; code writes fail, intended tmpfs writes succeed.
- Web/Worker combined health passes; graceful stop exits0.
- A disposable legacy SQLite is refused before Web/Worker start; database(+WAL) hashes do not change, container exits1/unhealthy.
- Docker errors redact keys/passwords from argv, stdout, stderr and saved reports. Commands have timeouts.
- Names and owner labels are registered before docker run. Cleanup handles failed/ambiguous starts and only removes this run’s containers.
- No yanxing_data/Caddy volume is mounted, no unrelated process/container is stopped, no prune is run.

Final evidence: `out/p5-verified-container.json`. Acceptance containers were removed; non-latest QA images remain available for review. The Docker restore mount-root constraint and maintenance-container procedure are documented in the P5 record.
