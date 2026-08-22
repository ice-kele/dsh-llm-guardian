# DSH LLM Guardian

[简体中文](README.zh-CN.md) | English

`dsh-llm-guardian` is a community plugin for DeepSeek Harness. It adds provider health checks, local token quotas, and provider-scoped account or plan usage queries to the Models settings page without storing API keys in the plugin settings.

## Provider cards

The plugin contributes a health-test action, a model-usage action, and a compact status summary to every configured provider card. When a plan API returns quota windows, the card shows the remaining capacity and live reset countdown for windows such as `5h` and `7d`, with green, orange, and red risk states as utilization rises.

![Provider health and usage controls](docs/images/provider-cards.png)

## Local usage dashboard

The optional dashboard aggregates local session logs into 7, 30, or 90-day views. It includes model filtering, summary metrics, an activity heatmap, a responsive daily token chart, model share, and detailed hover values.

![Local model usage dashboard](docs/images/usage-dashboard.jpg)

## Features

- Periodic and on-demand provider health checks.
- Local token counters and optional request blocking after a configured quota is reached.
- Provider-scoped account or plan usage queries with `5h` / `7d` quota windows, reset countdowns, and explicit timeout and refresh controls.
- Built-in query adapters for DeepSeek balance and Z.AI Coding Plan quotas.
- Local session-log statistics with model filtering, activity heatmap, daily token trends, and model share.
- Secret redaction, response-size limits, and same-origin restrictions for custom usage queries.

## Install from GitHub

```sh
dsh plugin add github:ice-kele/dsh-llm-guardian
```

Restart DeepSeek Harness or DSH Desktop after installation. The provider controls appear under **Settings → Models**.

## Compatibility

The plugin prefers the typed `settings.models.provider.action` and `settings.models.provider.summary` slots. A compatibility adapter is included for current DSH releases that do not expose those slots yet. The proposed upstream slot patch is tracked separately so the DOM compatibility adapter can be removed after the extension points are available.

## Privacy and network behavior

- API keys are resolved through the DSH credentials service and are not persisted by this plugin.
- Health checks call the configured provider model-discovery endpoint.
- Usage queries are limited to HTTPS endpoints on the provider origin; loopback HTTP is allowed for local providers.
- Local counters and query results are stored in the `llm-guardian` settings namespace.
- Dashboard statistics are computed locally from DSH session logs and are not uploaded by this plugin.

## Plugin marketplace

This project is designed as an ordinary composable DSH plugin and uses no Electron-only API. If DSH Desktop does not bundle or directly reference it, we would appreciate the project being considered for the forthcoming plugin marketplace. Add the repository topic `dsh-plugin` to keep ecosystem discovery machine-readable.

## Development

```sh
npm install
npm run check
npm pack --dry-run
```

## License

[MIT](LICENSE)
