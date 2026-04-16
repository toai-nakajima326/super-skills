---
name: network-protocol-testing
description: "Use when validating HTTP/FTP connectivity or other protocol-specific command-line tests."
origin: auto-generated
---

## Rules

1. Use CLI tools like curl, telnet, or nmap for protocol testing.
2. Validate responses against expected status codes or data patterns.

## Workflow

1. Execute CLI command to test protocol connectivity (e.g., curl -I http://example.com).
2. Analyze output for success indicators (e.g., 200 OK for HTTP).

## Gotchas

- Some protocols require specific ports or authentication.
- Firewalls or network policies may block tests.