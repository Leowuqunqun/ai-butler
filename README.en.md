# AI Butler

[![CI](https://github.com/Leowuqunqun/ai-butler/actions/workflows/ci.yml/badge.svg)](https://github.com/Leowuqunqun/ai-butler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

[中文](README.md) | English

**Talk like a human in WeChat. Remote-control your own computer.**

It's not remote desktop (that means doing everything yourself), and it's not command-line
forwarding (that means knowing the commands) — it's **replacing computer operation with AI
semantics**: you say what you want, and it goes and finds it, changes it, gets it done.

```
You (WeChat on your phone): 「把桌面那堆图按日期整理一下」
                             (tidy up that pile of images on my desktop, by date)
The butler (your computer):  「32 张图，按拍摄月份分成了 5 个文件夹。要看看清单吗？」
                             (32 images, sorted into 5 folders by shooting month. Want to see the list?)
```

![Overall architecture](docs/diagrams/arch-00-overview.svg)

> **Note:** all diagrams under `docs/diagrams/` are labeled in Chinese — we didn't fake it.
> The diagram sources (`.mmd` / `.svg`) are in the repo, so English versions are welcome.

---

## What this is

**A butler that lives on your own computer, and you talk to it in WeChat.**

It is not a WeChat bot framework, and it is not remote desktop: **there is no need for network
tunneling between phone and computer** — the phone goes through WeChat, the computer long-polls
Tencent's servers, and iLink itself is that ready-made public relay.
(Only "hub → other nodes" goes over the LAN or Tailscale, and **we run no servers of our own**.)

Wiring up a new IM, swapping out the brain that does the work, or adding a link — each one has a
**seam package that declares nothing but the contract**: `ctx.channel` / `ctx.agent` / `ctx.link`.
The second channel (Telegram) and the second brain (any command line) are there to put those
three seams to the test.
What it should become, and what it explicitly won't do → [VISION.md](docs/VISION.md).

---

## Quick start

**One line** (macOS / Linux — no Node needed; it downloads one and checks the SHA256):

```sh
curl -fsSL https://github.com/Leowuqunqun/ai-butler/releases/latest/download/install.sh | sh
```

Prefer not to touch a terminal? Download the bundle, unzip it, and **double-click `install.command`** → <https://github.com/Leowuqunqun/ai-butler/releases/latest>

When it finishes, your browser opens a page and **only two steps are left**: paste a model key once,
then scan one QR code with your phone.
(On macOS the first double-click gets blocked — right-click it → Open. We didn't buy Apple's
signing certificate.)

The full walkthrough (written for a completely non-technical reader, with a tick-off acceptance
checklist and a "stuck? look here" table; Chinese only, on purpose) →
[**From zero to driving your computer from WeChat: three steps**](docs/GETTING-STARTED.md)
Command-line details live in [`packages/cli`](packages/cli) (937 offline tests across the repo).

**Already running DSH and only want a WeChat channel inside it?** Then skip the whole stack above — the built bundle ships in the Release, and one command installs it into a profile:

```sh
curl -fsSL https://github.com/Leowuqunqun/ai-butler/releases/download/v0.1.0/butler-dsh-plugin-0.1.0.tar.gz | tar xz
dsh plugin --profile web add "file:$(pwd)/butler-dsh-plugin-0.1.0/plugin"
```

Config (`cwd` / `owner` / QR port / `autostart`), what it does **not** do, and how to verify it yourself first → [**dsh-plugin/README.md**](packages/dsh-plugin/README.md)

---

## What works today

This repo is growing from "a WeChat bridge that works" into "a complete butler product".
**What actually runs today is the bottom two layers** (connection + conversation); the layers
above are still being designed or built:

| Layer | What | Status |
| --- | --- | --- |
| ① Connection | One-line install (double-click `install.command`) + QR login + onboarding page | ✅ **Works** (no Node to install, no admin password) |
| ① Connection | **Third IM: Feishu** (on top of the official `@larksuite/channel`; we only write the mapping) | 📐 Skeleton + CLI wired (`--im feishu`); **not yet verified on a real device** |
| ② Conversation | Send/receive text, voice transcription, **send files / images / videos**, quote prefix | ✅ **Works** |
| ② Conversation | **Receiving images / files** (CDN download + decrypt + saved locally, handed to the agent) | ✅ **Works** |
| ③ Capability | The agent does the work (pluggable backends: DSH / any command line) | ✅ **Works** |
| ③ Capability | Memory, proactive reminders | Memory ✅ usable (`记住` / writing `[[记住: …]]` in a reply records it automatically); proactive reminders 📐 not started |
| ④ Devices | Multi-terminal (hub + nodes + alias routing + pairing devices from WeChat) | ✅ **works** (two machines; `@the-one-at-home` in WeChat reaches that one) |
| ⑤ Trust | Approval, audit | Approval ✅ usable (it asks in WeChat; a time-limited standing authorisation is possible); audit 📐 not started |

The evidence for every layer above (the M1/M2/M3 breakdowns, how the 937 cases are distributed,
which ones are end-to-end, what the clean-room acceptance runs caught) → [**EVIDENCE.md**](docs/EVIDENCE.md)

---

## Repo layout

```
packages/
  seam-channel/        ✅ channel service slot ctx.channel (TypeScript; interfaces only, no implementation)
  seam-agent/          ✅ agent service slot ctx.agent (interfaces only, no implementation)
  seam-link/           ✅ link service slot ctx.link (interfaces only, no implementation)
  seam-approval/       ✅ approval service slot ctx.approval (interfaces only, no implementation)
  seam-memory/         ✅ memory service slot ctx.memory (interfaces only, no implementation)
  core/                ✅ the kernel (the hub role): claim ownership, routing, queue, progress, reply, approval relay, self-check
  channel-wechat/      ✅ channel implementation: WeChat (iLink protocol) QR login, send/receive, attachments, pluggable backends
  channel-telegram/    ✅ channel implementation: Telegram (pure `fetch`, zero deps, long-poll; the second channel — this is what proves the abstraction)
  agent-dsh/           ✅ agent implementation: DSH headless agent (with tool-level progress)
  agent-exec/          ✅ agent implementation: any "one question, one answer" command-line program
  approval-im/         ✅ approval implementation: ask the owner in the conversation (default)
  memory-file/         ✅ memory implementation: JSON files (0600 + atomic writes)
  link-lan/            ✅ link implementation: LAN (HTTP + SSE, zero dependencies; authentication is a red line; a pairing code admits devices)
  link-tailscale/      ✅ link implementation: across networks (the roster is asked of Tailscale; the wire protocol is link-lan's)
  cli/                 ✅ the entry point `butler`: config + patch overlay → bring up the container → go online / `doctor` self-check
  channel-feishu/      📐 third channel: Feishu (on top of the official @larksuite/channel; 50 offline tests, inbound images/files land on disk; not yet verified on a real device)
  (the following are not packages yet)
  hub/ node/           —— the roles already have owners: hub is `core/`, node is `link-lan/node`
  installer/           —— the installer script already ships at the repo root (install.sh); the package isn't split out yet
docs/                  product and technical architecture, 18 diagrams
scripts/               diagram rendering + docs/package-structure checks + mutation testing
```

---

## Docs

| Doc | What's in it |
| --- | --- |
| [VISION.en.md](docs/VISION.en.md) | Goals, the end state, the conclusions on three forks in the road, the hard parts |
| [ARCH-product.en.md](docs/ARCH-product.en.md) | The five-layer capability model, the user journey, the four core mechanisms, product boundaries |
| [ARCH-technical.en.md](docs/ARCH-technical.en.md) | Topology, packages and seams, contracts, patch layering, sequence, degradation table |
| [GLOSSARY.md](docs/GLOSSARY.md) | **Chinese↔English term table**: the rules translations follow, and a key to the Chinese source comments |
| [docs/diagrams/](docs/diagrams/) | 18 architecture diagrams (sources and color conventions included) — start with the [overall architecture](docs/diagrams/arch-00-overview.svg) |
| [seam-channel/README.md](packages/seam-channel/README.md) | **Read this to wire up a new IM (Telegram/飞书…)**: contract, examples, the foot-guns we hit |
| [CHANNEL-FEISHU.md](docs/CHANNEL-FEISHU.md) | **Read this to see whether Feishu/Lark can be wired in, and what it costs**: the access model and permission scopes, the hard limits of long-connection mode, a line-by-line mapping onto `ctx.channel`, a cost estimate, and the five decisions to make before starting (**research only, not started**; Chinese only) |
| [seam-agent/README.md](packages/seam-agent/README.md) | **Read this to swap out the agent doing the work**: the `ctx.agent` contract, examples, the four rules for implementers |
| [seam-link/README.md](packages/seam-link/README.md) | **Read this to add a new link (Tailscale/SSH/your own relay)**: the `ctx.link` contract, the security red line, why progress hangs off the request |
| [cli/README.md](packages/cli/README.md) | **Read this to actually run it**: what `butler init` generates, config format, patch semantics, `butler run`, `butler doctor` |
| [dsh-plugin/README.md](packages/dsh-plugin/README.md) | **Read this to add a WeChat channel to DSH alone, without the whole stack**: one-command install from the Release into a profile, the config table (`cwd` / `owner` / ports / `autostart`), what it does not do, and how to run the real-DSH acceptance probe yourself (`probe/run.sh`) |
| [EVIDENCE.en.md](docs/EVIDENCE.en.md) | **Read this to see why it should be believed**: the acceptance breakdown for every layer, the end-to-end cases, a real install in a clean environment, mutation testing |

Every other package (`core` / `link-lan` / `link-tailscale` / `agent-dsh` / `agent-exec` / `channel-wechat` / `channel-telegram` / `approval-im` / `memory-file` / `seam-approval` / `seam-memory`) has its own `README.md` in its directory.

---

## Development

```bash
pnpm install            # install deps (Node ≥ 20, pnpm 10)
pnpm build              # build the TypeScript packages → lib/
pnpm typecheck          # type-check only, no output
pnpm test               # every package, fully offline: no network, no WeChat account, no messages actually sent
pnpm check:docs         # docs health check: broken links / anchors / references to gitignored files
pnpm check:packages     # packaging health check: every entry point and build artifact ships
pnpm mutate             # mutation testing: it verifies not the code but **the tests themselves** (ten-odd minutes, run by hand)
pnpm diagrams           # re-render docs/diagrams/*.svg
```

**The tests are deliberately built to run offline**: the WeChat media part forges its own CDN
ciphertext and runs its own AES decryption to verify things, so it needs no real account and
sends messages to nobody. CI runs the full suite on Node 20 / 22 / 24.

**Why those checks exist** (every one of them was forced into existence by a real incident) → [EVIDENCE.md](docs/EVIDENCE.md)

---

## Roadmap

| | What | Acceptance | Status |
| --- | --- | --- | --- |
| **M0** | Channel layer working end to end: QR, send/receive, attachments, quotes, pluggable backends | 19 offline tests | ✅ Done |
| **M1** | Channel layer plugins + receiving images/files + `doctor` self-check + CI + Chinese/English docs | **ready to open-source once done** | ✅ Done |
| **M2** | Multi-terminal (hub + nodes + alias routing) + in-WeChat configuration | Two machines; saying "that file on the home computer" in WeChat gets it | ✅ complete |
| **M3** | Non-technical installer (double-click install, onboarding page QR scan, never asks for a key) + a second IM channel | A non-technical user walks the whole thing alone | 🚧 in progress |

The milestone breakdowns, and how each one was verified → [EVIDENCE.md](docs/EVIDENCE.md)

---

## Three key design calls

1. **Phone to computer needs no network tunneling.** The phone goes through WeChat, the computer
   long-polls Tencent's servers — iLink itself is that ready-made public relay. That's also why
   "controlling the home computer from outside" costs nothing.
   Only **hub → other nodes** needs tunneling, and that goes over `ctx.link` (LAN / Tailscale).
   **We run no servers of our own.**
2. **The agent runs on whichever machine the work happens on.** The hub only handles identifying
   people, routing, approval, and memory. It **never reads files on a node's behalf** — otherwise
   the hub becomes a bottleneck and a privacy black hole.
3. **The architecture aligns with dsh, but dsh's complexity never leaks to non-technical users.**
   The seam split, patch composition, and dependency injection are all lifted straight from dsh
   (even the kernel uses the same cordis), but the patch files are **an escape hatch for developers
   and advanced users**, not the product interface.

---

## License

MIT © 2026 吴群群 (Wu Qunqun)
