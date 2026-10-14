# AI Butler

[![CI](https://github.com/Leowuqunqun/ai-butler/actions/workflows/ci.yml/badge.svg)](https://github.com/Leowuqunqun/ai-butler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

[中文](README.md) | English

Remote-control your own computer from your chat app. You say what you want; it goes and finds it, changes it, gets it done.

WeChat, Feishu/Lark and Telegram all work. One channel at a time.

```
You (WeChat / Feishu / Telegram on your phone): 「把桌面那堆图按日期整理一下」
                                                (tidy up that pile of images on my desktop, by date)
The butler (your computer):  「32 张图，按拍摄月份分成了 5 个文件夹。要看看清单吗？」
                             (32 images, sorted into 5 folders by shooting month. Want to see the list?)
```

![Overall architecture](docs/diagrams/arch-00-overview.svg)

> All diagrams under `docs/diagrams/` are labeled in Chinese. The sources (`.mmd` / `.svg`) are in the
> repo, so English versions are welcome.

## How it works

The butler runs on your own computer. The work is done by a DSH (DeepSeek Harness) headless agent, which reads and writes files and runs commands, so "tidy up my desktop" really does tidy it up instead of handing you a list of steps to follow.

No network tunneling is needed between phone and computer. All three channels are the **computer dialing out**: WeChat long-polls Tencent's servers, Telegram long-polls the Bot API, Feishu/Lark holds a WebSocket long connection. Those servers are the ready-made relay, and we run no servers of our own. Only hub → other nodes needs tunneling, and that goes over the LAN or Tailscale.

The capability slots are split into five seam packages that declare nothing but a contract: `ctx.channel` / `ctx.agent` / `ctx.link` / `ctx.approval` / `ctx.memory`. The second and third channels came in exactly this way: each added one package, and **not one line changed in the kernel**. What did change was the channel enum, the credential shape and the onboarding wording on the CLI side.

What it should become, and what it explicitly won't do: [VISION.en.md](docs/VISION.en.md)

## Quick start

macOS / Linux, one line. No Node needed; it downloads one and checks the SHA256:

```sh
curl -fsSL https://github.com/Leowuqunqun/ai-butler/releases/latest/download/install.sh | sh
```

Prefer not to touch a terminal? Download the bundle, unzip it, and double-click `install.command`: [Releases](https://github.com/Leowuqunqun/ai-butler/releases/latest)

When it finishes, your browser opens an onboarding page and only two steps are left: paste a model key once, then hand the channel its credentials. WeChat wants one QR scan; Feishu and Telegram want a pasted string (`app_id` + `app_secret` / a bot token). On macOS the first double-click gets blocked, so right-click it and choose Open; we didn't buy Apple's signing certificate.

The full walkthrough (written for a completely non-technical reader, with a tick-off acceptance checklist and a "stuck? look here" table; Chinese only, on purpose, and WeChat is the default path with sections of its own for Feishu and Telegram): [GETTING-STARTED.md](docs/GETTING-STARTED.md)

Command-line details are in [packages/cli](packages/cli). The repo has nine hundred-odd offline cases, which you can count yourself: `pnpm test`.

### Already running DSH and only want a channel

Then skip the whole stack above. The built bundle ships in the Release, and one command installs it into a profile:

```sh
curl -fsSL https://github.com/Leowuqunqun/ai-butler/releases/download/v0.2.1/butler-dsh-plugin-0.2.1.tar.gz | tar xz
dsh plugin --profile web add "file:$(pwd)/butler-dsh-plugin-0.2.1/plugin"
```

Config (`cwd` / `owner` / port / `autostart`), what it does not do, and how to verify it yourself first: [packages/dsh-plugin](packages/dsh-plugin/README.md)

## What works today

This repo is growing from "a WeChat bridge that works" into "a complete butler product". What actually runs today is the connection and conversation layers; the ones above are still being designed or built:

| Layer | What | Status |
| --- | --- | --- |
| Connection | One-line install (double-click `install.command`) + onboarding page, no Node to install, no admin password | Works |
| Connection | Pick one of three channels: WeChat (QR) / Feishu/Lark (a self-built app in your tenant, on top of the official `@larksuite/channel`) / Telegram (a bot token) | All three work. WeChat and Telegram have been running for a while; Feishu was verified on a real tenant on 2026-10-14 |
| Connection | Several IMs at once (WeChat and Feishu side by side) | Not supported. One context holds a single channel slot; the write-up is in [CHANNEL-FEISHU.md](docs/CHANNEL-FEISHU.md) section 13 (Chinese only) |
| Conversation | Send/receive text, voice transcription, send files / images / videos, quote prefix | Works |
| Conversation | Receiving images and files (CDN download + decrypt + saved locally, handed to the agent) | Works |
| Capability | The agent does the work (pluggable backends: DSH / any command-line program) | Works |
| Capability | Memory | Works. Writing `[[记住: …]]` in a reply records it |
| Capability | Proactive reminders | Not started |
| Devices | Multi-terminal: hub + nodes + alias routing + pairing devices from the conversation | Works. Two machines; saying `@the-one-at-home` reaches that one |
| Trust | Approval | Works. It asks in the conversation, and a time-limited standing authorisation is possible |
| Trust | Audit | Not started |

The evidence for every layer above (the M1 / M2 / M3 breakdowns, how the cases are distributed, which ones are end-to-end, what the clean-room acceptance runs caught): [EVIDENCE.en.md](docs/EVIDENCE.en.md)

## Repo layout

```
packages/
  seam-channel/        channel service slot ctx.channel (TypeScript; interfaces only, no implementation)
  seam-agent/          agent service slot ctx.agent (interfaces only, no implementation)
  seam-link/           link service slot ctx.link (interfaces only, no implementation)
  seam-approval/       approval service slot ctx.approval (interfaces only, no implementation)
  seam-memory/         memory service slot ctx.memory (interfaces only, no implementation)
  core/                the kernel (the hub role): claim ownership, routing, queue, progress, reply, approval relay, self-check
  channel-wechat/      channel implementation: WeChat (iLink protocol) QR login, send/receive, attachments
  channel-telegram/    channel implementation: Telegram (pure fetch, zero deps, long-poll)
  channel-feishu/      channel implementation: Feishu/Lark (on top of the official @larksuite/channel; inbound images and files land on disk)
  agent-dsh/           agent implementation: DSH headless agent (with tool-level progress)
  agent-exec/          agent implementation: any "one question, one answer" command-line program
  approval-im/         approval implementation: ask the owner in the conversation (default)
  memory-file/         memory implementation: JSON files (0600 + atomic writes)
  link-lan/            link implementation: LAN (HTTP + SSE, zero dependencies; a pairing code admits devices)
  link-tailscale/      link implementation: across networks (the roster is asked of Tailscale; the wire protocol is link-lan's)
  cli/                 the entry point butler: config + patch overlay → bring up the container → go online / doctor self-check
  dsh-plugin/          the plugin form, for adding a channel to DSH and nothing else
docs/                  product and technical architecture, 18 diagrams
scripts/               diagram rendering + docs / package-structure checks + mutation testing
```

`hub` / `node` / `installer` are not packages yet: hub is `core/`, node is `link-lan/node`, and the installer script already ships at the repo root (`install.sh`).

## Docs

| Doc | What's in it |
| --- | --- |
| [VISION.en.md](docs/VISION.en.md) | Goals, the end state, the conclusions on three forks in the road, the hard parts |
| [ARCH-product.en.md](docs/ARCH-product.en.md) | The five-layer capability model, the user journey, the four core mechanisms, product boundaries |
| [ARCH-technical.en.md](docs/ARCH-technical.en.md) | Topology, packages and seams, contracts, patch layering, sequence, degradation table |
| [GLOSSARY.md](docs/GLOSSARY.md) | Chinese↔English term table, the rules translations follow, and a key to the Chinese source comments |
| [docs/diagrams/](docs/diagrams/) | 18 architecture diagrams (sources and color conventions included), starting with the [overall architecture](docs/diagrams/arch-00-overview.svg) |
| [CHANNEL-FEISHU.md](docs/CHANNEL-FEISHU.md) | The Feishu access model and permission scopes, the hard limits of long-connection mode, a line-by-line mapping onto `ctx.channel`, a cost estimate; section 13 records the "several IMs at once" conclusion (Chinese only) |
| [EVIDENCE.en.md](docs/EVIDENCE.en.md) | The acceptance breakdown for every layer, the end-to-end cases, a real install in a clean environment, mutation testing |
| [seam-channel/README.md](packages/seam-channel/README.md) | Read this to wire up a new IM: contract, examples, the foot-guns we hit |
| [seam-agent/README.md](packages/seam-agent/README.md) | Read this to swap out the agent doing the work: the `ctx.agent` contract, examples, the four rules for implementers |
| [seam-link/README.md](packages/seam-link/README.md) | Read this to add a new link (Tailscale / SSH / your own relay): the `ctx.link` contract, the security red line |
| [cli/README.md](packages/cli/README.md) | Read this to actually run it: what `butler init` generates, config format, patch semantics, `doctor` |
| [dsh-plugin/README.md](packages/dsh-plugin/README.md) | Read this to add a channel to DSH alone: one-command install from the Release into a profile, and how to run the real acceptance probe |

Every other package (`link-lan` / `link-tailscale` / `agent-dsh` / `agent-exec` / `channel-wechat` / `channel-telegram` / `channel-feishu` / `approval-im` / `memory-file` / `seam-approval` / `seam-memory`) has its own `README.md` in its directory.

## Development

```bash
pnpm install            # install deps (Node ≥ 20, pnpm 10)
pnpm build              # build the TypeScript packages → lib/
pnpm typecheck          # type-check only, no output
pnpm test               # every package, fully offline: no network, no IM account, no messages actually sent
pnpm check:docs         # docs health check: broken links / anchors / references to gitignored files / links inside shipped docs
pnpm check:packages     # packaging health check: every entry point and build artifact ships, runtime deps declared
pnpm check:scripts      # script health check: no backticks in printing headings, none in unquoted heredocs
pnpm check:user-facing  # copy health check: nothing printed at the user may mention packages/ docs/ scripts/
pnpm mutate             # mutation testing: it verifies not the code but the tests themselves (ten-odd minutes, run by hand)
pnpm diagrams           # re-render docs/diagrams/*.svg
```

The tests are deliberately built to run offline: the WeChat media part forges its own CDN ciphertext and runs its own AES decryption to verify things, so it needs no real account and sends messages to nobody. CI runs the full suite on Node 20 / 22 / 24.

Why those checks exist (every one of them was forced into existence by a real incident): [EVIDENCE.en.md](docs/EVIDENCE.en.md)

## Roadmap

| | What | Acceptance | Status |
| --- | --- | --- | --- |
| M0 | Channel layer working end to end: QR, send/receive, attachments, quotes, pluggable backends | 19 offline tests at the time | Done |
| M1 | Channel layer plugins + receiving images and files + `doctor` self-check + CI + Chinese/English docs | ready to open-source once done | Done |
| M2 | Multi-terminal (hub + nodes + alias routing) + configuring it from the conversation | Two machines; saying "that file on the home computer" in the conversation gets it | Done |
| M3 | Installer (double-click install, onboarding page QR scan, never asks for a key) + a second IM channel | A non-technical user walks the whole thing alone | In progress |

The milestone breakdowns, and how each one was verified: [EVIDENCE.en.md](docs/EVIDENCE.en.md)

## Design decisions

1. **No network tunneling between phone and computer.** All three channels are the computer dialing out: WeChat long-polls Tencent's servers, Telegram long-polls the Bot API, Feishu/Lark holds a WebSocket long connection. Their servers act as the relay, and we run no servers of our own, which is also why controlling the home computer from outside costs nothing. Only hub → other nodes needs tunneling, and that goes over `ctx.link` (LAN / Tailscale).
2. **The agent runs on whichever machine the work happens on.** The hub only handles identifying people, routing, approval, and memory. It never reads files on a node's behalf, otherwise the hub becomes a bottleneck and a privacy black hole.
3. **The architecture aligns with dsh, but dsh's complexity never leaks to non-technical users.** The seam split, patch composition, and dependency injection are all lifted straight from dsh (even the kernel uses the same cordis), but the patch files are an escape hatch for developers and advanced users, not the product interface.

## License

MIT © 2026 吴群群 (Wu Qunqun)
