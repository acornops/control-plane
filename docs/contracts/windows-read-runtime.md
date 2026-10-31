# Windows read runtime contract

This is the additive Windows producer contract consumed by the control plane.
It does not change Linux tools or `acornops.agentv-snapshot.v2`. Existing Linux
snapshots need no new discriminator. Windows onboarding remains disabled until
backend, native collectors, service packaging and rollout gates are qualified.

## Identity and tools

Windows handshakes require `hostFeatures.osFamily: "windows"` and
`hostFeatures.serviceManager: "scm"`. Optional helper/restart fields may be
omitted. Capabilities are `read`, `mcp`, `scm`, `windows`, with `logs` only when
locally enabled. The eight read names have independent native schemas,
version `1.0.0`, the existing common tool envelopes, redaction and executor
limits. No restart tool is registered, even under a hostile remote write policy.

| Tool | Native inputs (all objects reject unknown keys) |
| --- | --- |
| `get_host_summary` | Empty object |
| `list_filesystems` | `limit` 1–100, default 50 |
| `list_processes` | Optional literal `query` up to 256 characters; `limit` 1–100, default 50 |
| `get_process` | Positive integer `pid`, at most 4294967295 |
| `list_services` | Optional literal `query`; `state`: `all` (default), `Running`, `Stopped`, `failed`; `limit` 1–200, default 100 |
| `get_service` | Exact native `name`, 1–256 characters, no controls or slash/backslash; no `.service` suffix normalization |
| `list_listeners` | Optional `protocol`: `tcp`/`udp`, optional `port` 1–65535; `limit` 1–200, default 100 |
| `query_logs` | Required `channel`: `Application`/`System`, optional ISO timestamps `since`/`until`, optional literal `query`; `limit` 1–500, default 100; `byte_limit` 1024–1048576, default 262144 |

Logs require the channel in `ACORNOPS_VM_ALLOWED_LOG_CHANNELS`. No channel is
allowed by default. The default window is the last hour; maximum window is 24
hours, ordered and no more than one minute into the future. Enumeration is
bounded before literal filtering; a query cannot claim exhaustive search beyond
the retained native window. Event messages are capped at 16384 characters;
row, message or byte trimming is reported as partial/truncated. Process command
lines, environments, executable paths and event logs never enter snapshots.

## Exact Windows data types

All rows and host objects reject unknown fields. `number?` below means nullable,
not a fabricated zero. Byte/count fields are nonnegative; percentages are numeric.

| Object | Fields |
| --- | --- |
| Host | `os_family: "windows"`, `hostname`, `version`, `build`, `product_type: 2\|3`, `architecture`, `system_volume` (native drive identity such as `C:`), `uptime_seconds`; `cpu: {usage_percent: number\|null, sampled_ms: integer}`; `memory: {total_bytes, available_bytes, used_bytes, used_percent}`; `collector_health: Health[]` |
| Volume | `volume: string`, `filesystem: string\|null`, `total_bytes`, `free_bytes`, `used_bytes`, `used_percent`: each `number\|null` |
| Process | `pid: integer`, `ppid: integer\|null`, `name: string`, `cpu_percent: number\|null`, `memory_bytes: number\|null`, `start_time: string\|null` |
| Service | `name`, `display_name`: strings; `state`, `start_mode`: `string\|null`; `process_id`, `exit_code`, `service_specific_exit_code`: `integer\|null` |
| Listener | `protocol: "tcp"\|"udp"`, `address: string`, `port: integer`, `pid: integer\|null`, `ownership_status: "available"\|"unavailable"\|"permission_denied"` |
| Event | `channel: "Application"\|"System"`, `record_id: integer`, `timestamp: string`, `level: integer\|null`, `provider: string\|null`, `event_id: integer`, `message: string` |
| Health | `collector: string`, `status: "ok"\|"partial"\|"unavailable"\|"permission_denied"\|"timed_out"\|"unsupported"`, `duration_ms: integer`, optional `message` |

Lists return `{items, original_count, omitted_count, health}`. When native
collection is capped, counts are conservative lower bounds and health is
partial; omitted count is at least one. Logs return `{entries, returned_count,
original_count, byte_count, truncated, health}`. The log `original_count` is the
number observed after literal filtering, not a total count of all matching
Windows events. Load, swap, inodes and per-process CPU sampling are unavailable;
they are absent or explicitly null, never zero substitutes.

## Snapshot

`schema_version` is exactly `acornops.agentv-windows-snapshot.v1`.
The gzip JSON-RPC `notify/snapshot` notification retains the common timestamp
and contains these exact outer collections:

| Field | Windows type |
| --- | --- |
| `host_summary` | Host or null when unavailable |
| `filesystems` | Volume[], retained inventory at most 50 |
| `degraded_services` | Service[] with affirmative failure evidence, retained at most 50 |
| `top_processes` | Process[], at most 20 |
| `listeners` | Listener[], at most 50 |
| `findings` | Finding[]: `{severity:"critical",code,summary}` with `name` for `SERVICE_FAILED`, `volume` for `FILESYSTEM_PRESSURE`, neither for `MEMORY_PRESSURE` |
| `collector_health` | Health[] with native identities `windows_host`, `windows_volumes`, `windows_processes`, `windows_services`, `windows_listeners` |
| `finding_coverage` | `{filesystems:"complete"\|"incomplete", services:"complete"\|"incomplete"}` |
| `truncation` | Nonnegative lower-bound counts `{filesystems, services, processes, listeners}` |

Failure requires `state === "Stopped"`, a known non-disabled start mode
(`Auto`, `Automatic`, `Manual`), and numeric `exit_code` other than 0 or 1077.
`service_specific_exit_code` is retained only when `exit_code === 1066`; otherwise
it is null. Stopped demand/disabled/never-started services alone are normal.
Missing state/start/exit evidence and transitional states make service coverage
incomplete. Permission failure, partial enumeration and collector truncation
cannot assert service recovery. Findings are evaluated before inventory trimming
and retained together with coverage, or the entire over-budget snapshot is
dropped. Filesystem and memory pressure use the existing 90% threshold.

## Execution and native qualification

`acornops.windows-collectors.v1` fixed script identifiers use absolute Windows PowerShell, UTF-16LE
encoded fixed code and UTF-8 JSON stdin. Input never becomes code or WQL. Each
script runs for at most eight seconds, combined stdout/stderr is at most 1 MiB,
and enumeration is capped at 1000 retained rows plus a truncation sentinel.
Event enumeration is additionally capped at the requested 500-row maximum and
native byte budget. A minimal environment excludes credentials, profile/module
search paths outside system modules, and Node preload/debug variables.
Cancellation kills the exact collector; shutdown drains tracked child closure.

Standalone live mode currently trusts only the standard
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` path, refuses
redirection, and never discovers from PATH/SystemRoot. The native host may
supply an OS-API-discovered trusted system directory through private START data;
protected config cannot select it. Custom system directories are not yet
qualified. Live startup requires x64 Node 22/24 and Windows Server build 20348
(2022) or 26100 (2025), with native Server product type. Synthetic Windows mock
selection is explicit and independent of the machine OS.

The additive `windows-collectors.yml` matrix runs Windows 2022/2025 on Node
22/24. Its artifact contains only structural keys/counts, SCM state/start/exit
code tuples, script hashes and runner provenance. No machine/service/process
names, addresses, event messages, credentials or environment dumps are emitted.
This qualifies read parsing on those hosted images only; permissions under the
service SID, service hosting, actual reboot, transactional package recovery and
Core/Desktop Experience remain separate unqualified gates.
