# Contributing to SourceAtlas

Start with the README's local demo and run `npm run build`, `npm test`, and the browser tests before opening a pull request. Use Node.js 24+. Include a short description of the behavior changed and how you validated it.

For collector work, provide synthetic fixtures. Never commit real inventory exports, cloud account metadata, tokens, kubeconfigs, or production credentials. Keep cloud collection read-only. Preserve explicit digest-based identity and surface unknown attribution instead of guessing.

Discuss substantial schema, authorization, or infrastructure changes in an issue first. Small fixes and documentation improvements are welcome directly. Contributions are licensed under Apache 2.0, as described in LICENSE.
