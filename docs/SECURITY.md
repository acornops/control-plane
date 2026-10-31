# Security Policy

## Supported Versions

AcornOps is under active development. Security reports are accepted for the
current default branch and any active development branches maintained by the
AcornOps team.

## Reporting a Vulnerability

Please do not open a public GitHub issue for suspected security
vulnerabilities.

Report security issues through the AcornOps Discord:

https://discord.gg/KHUUdXfsXv

Include enough detail for maintainers to understand and reproduce the issue,
such as affected repositories, components, versions or commit SHAs, impact,
steps to reproduce, and any relevant logs or screenshots. Do not include live
secrets, tokens, private keys, or customer data in the report.

## Disclosure

Give the AcornOps maintainers time to acknowledge, investigate, and remediate a
valid vulnerability before public disclosure. Maintainers may follow up through
Discord for reproduction details, mitigation guidance, and coordinated
disclosure timing.

## HTTP body parser logging

Both HTTP listeners handle JSON parsing failures at the parser boundary. Logs
contain only the request ID, normalized status, and fixed error code; parser
exception bodies, messages, stacks, and causes are never serialized. Malformed,
oversized, and unsupported bodies return safe 400, 413, and 415 error envelopes.
The 4 MiB limit, compression support, and exact valid bytes used for webhook
signature verification are preserved.
