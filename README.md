# pi-github-copilot-web-search

A Pi extension that adds a GitHub Copilot-aware web tool:

- `web_search` for `github-copilot` and `openai-codex` models (Codex support is experimental)

## Install locally

Place this folder in a trusted location or add it to your Pi extensions list.

```json
{
  "extensions": ["/path/to/pi-github-copilot-web-search"]
}
```

## Notes

- `web_search` is automatically hidden unless the active model is a GitHub Copilot or OpenAI Codex model.
- `web_search` uses the GitHub Copilot Node SDK and a local Copilot CLI session. Codex support currently reuses this backend experimentally.
- For `web_search`, the local GitHub Copilot CLI must be installed and authenticated.
