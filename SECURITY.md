# Security

SourceAtlas is an early-stage inventory tool. Only the latest main branch is currently maintained. The current release uses a single workspace with static reader and collector tokens; it has no built-in user identity, fine-grained RBAC, signed provenance verification, or audit trail.

For vulnerabilities, use GitHub's private vulnerability reporting feature on this repository when available. Do not post secrets, real asset inventories, or exploit details affecting active installations in public issues. If private reporting is unavailable, open an issue requesting a private contact channel without including sensitive details.

Keep the app behind HTTPS and your organizational access controls when serving real inventories. Use read-only AWS/Kubernetes permissions for collectors. Treat provenance submitters as trusted writers and keep WRITE_TOKEN out of browsers. Rotate credentials after suspected exposure, and back up your Neo4j data.
