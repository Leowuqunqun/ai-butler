# Goals and Final Form

[中文](VISION.md) | English

> **Note on the diagrams:** this document does not embed any itself, but the
> linked docs ([`ARCH-product.en.md`](ARCH-product.en.md) and
> [`ARCH-technical.en.md`](ARCH-technical.en.md)) and the
> [project home page](../README.en.md) use the English set in [`diagrams/en/`](diagrams/en/).
> The Chinese originals sit next to them in [`diagrams/`](diagrams/) — same pictures,
> same order, only the labels differ. The `.mmd` sources are what you edit, and
> `bash scripts/render-diagrams.sh` re-renders both sets.

> This document defines the **product**, not this particular repo.
> Today's `wechat-agent-bridge` is **the first component of the product's channel
> layer** (M0 is done).

---

## In One Sentence

**Talk plain language into WeChat; remote-control your own computer — like bossing around a butler.**

This is not "remote desktop," and it is not "forwarding a command line." It is
**replacing computer operation with AI semantics**: you say what you want, and it
goes and clicks, searches, and edits on its own. You never tell it where to click.

---

## The Form Is Locked In

Conclusions on the three forks in the road (details in their own sections below):

| Decision | Conclusion |
| --- | --- |
| **Multi-terminal across networks** | Make it a `ctx.link` seam; M2 implements `link-lan` + `link-tailscale`. **We do not build or operate any server** |
| **Who pays for model tokens** | **Users bring their own key** (the onboarding page makes it foolproof); the code leaves a seam for a "hosted channel" |
| **Repo shape** | **monorepo** (pnpm workspace): `core` / `channel-wechat` / `hub` / `node` / `link-*` / `installer` |
| **Multi-user** | ❌ Not doing it. The positioning is "your own butler" |

---

## Final Form (the complete experience from the user's point of view)

The target user is **someone with no technical background at all**. So none of these
may show up anywhere in the journey: a terminal, a config file, an API key, a port,
a path.

### 1. Install

Download an installer, double-click. Or copy one line into a terminal — but **that is
the only case that needs a terminal**, and for non-technical users we can ship a
graphical installer.
No pre-installed Node, no need to know git.

### 2. Connect

When installation finishes, an **onboarding page** (a local web page) pops up:

- Show a QR code → scan it with WeChat on your phone → done
- It asks exactly two questions:
  - "Which computer do you want me to manage?" (default: this one)
  - "What do you usually use it for?" (used to generate the initial persona; skippable)
- It does **not** ask for an API key, a working directory, or a port

> Key point: the QR page must **refresh the code automatically**. A QR code lives only
> about 90 seconds; a static image is guaranteed to fail the scan —
> we already hit this in M0 and fixed it (`src/qr-page.mjs`).

### 3. Use

Say plain language in WeChat:

```
「帮我把桌面上那堆图按日期整理进文件夹」
    (tidy that pile of images on my desktop into folders, by date)
「我昨天写的那个文档发我」
    (send me the document I wrote yesterday)
「家里那台电脑上有个叫 xxx 的，找出来发我」     ← multi-terminal
    (there is something called xxx on my home computer — find it and send it to me)
「下周三下午三点的会，帮我记一下」
    (put the meeting next Wednesday at 3pm on my calendar)
```

### 4. It Asks First

For anything destructive, it asks one question first — it does not just do it and
explain later:

```
管家：要删 32 个文件（都是 .tmp），确认？
    (the butler: about to delete 32 files, all .tmp — confirm?)
你：  确认
    (you: confirmed)
管家：删了。另外我把它们移到了废纸篓，一周内还能捞回来。
    (the butler: deleted. I moved them to the trash too, so you can recover them within a week.)
```

### 5. It Remembers

```
「以后简历都放 Documents/简历/」
    (from now on, put every resume in Documents/简历/)
→ remembered from then on — you never have to say it twice
```

(You don't have to say "remember" either: when it hears something durable, it records it and says so)

### 6. Configuration Also Happens in WeChat

This is the core of "usable by non-technical users": **there is no config file**.

```
「帮我改一下工作目录到 项目/2026」
    (change my working directory to 项目/2026)
「以后别在半夜给我发消息」
    (stop messaging me in the middle of the night)
「把操作的确认级别调高一点」
    (turn up the confirmation level for operations)
```

---

## The Three Forks That Decide the Form

### Fork 1: How Do Multiple Terminals Connect? (the hardest piece)

**⚠️ First separate "who needs to talk to whom" — these are two completely different things:**

| Link | Does it need NAT traversal? | Why |
| --- | --- | --- |
| **Phone → computer** | **No** | The phone goes through WeChat; the computer long-polls Tencent's servers. **iLink itself is the ready-made public relay** |
| **Hub → other devices** | **Yes** | This is the one that needs a path from the machine holding the login state to the other machines |

So "remote-control the computer at home from your phone while out" — **the core scenario
needs zero networking work**.
The cross-network problem only shows up when "the hub has to command another device on
a different network."

> Why "exactly one holder of the login state" is mandatory: a bot for one WeChat account
> can have only one receiver. Two processes long-polling at the same time will steal
> messages from each other and their cursors will fight. We measured this in M0.

**The three real cross-network paths (no sugar-coating):**

| Approach | How it works | Can a non-technical user do it? |
| --- | --- | --- |
| **Borrow an existing mesh network** (Tailscale / ZeroTier) | Install once and log in on every device, forming a virtual LAN; the hub connects straight to nodes by virtual IP | ✅ Double-click install + log in; the personal free tier is enough |
| **Self-hosted relay** | The user buys a cloud host to run a relay, and nodes connect to it | ❌ A non-technical user cannot pull this off |
| **Self-built P2P hole punching** | Do your own signaling + hole punching, fall back to a relay on failure | ⚠️ Success rate below 100%; fails on hostile NAT, so a fallback is mandatory |

**Decision (✅): make it a `ctx.link` seam** (exactly what dsh does — `ctx.shell` can swap
sandbox for local, `ctx.link` swaps the transport implementation). M2 implements only two:

- `link-lan` — direct connection on the same LAN (zero config)
- `link-tailscale` — cross-network: if Tailscale is detected, use it; if not installed,
  walk the user through installing it

Advanced users can write their own `link-ssh` / `link-relay`. **We operate no servers
ourselves** — the same principle as "users bring their own key, data never leaves the
machine."

### Fork 2: Who Pays for the Model? — ✅ Settled: users bring their own key

The onboarding page **walks them through applying and pasting** it, made foolproof
("click here to apply → copy → paste it here").
Zero cost to us, best privacy, and consistent with "data never leaves the machine."
The code layer leaves a seam for a "hosted channel" to open later, if we ever really
productize this.

### Fork 3: Repo Shape? — ✅ Settled: monorepo

```
packages/
  channel-wechat/     ← this one, already usable (M0)
  core/               ← the three seams ctx.channel / ctx.device / ctx.agent + sessions + permissions
  hub/                ← the hub: holds the WeChat login state, routing, device registry
  node/               ← device node: takes orders from the hub, executes them locally
  link-lan/ link-tailscale/   ← the two implementations of ctx.link
  installer/          ← the non-technical-user installer (M3)
```

Reasoning: dsh itself does exactly this (288 packages + pnpm workspace + patch
composition), and the goal is to "follow dsh's architecture as a whole." Plus the
channel layer is already usable on its own — it is exactly the first package.

---

## Architecture: The Concrete Mapping onto dsh

dsh's architecture boils down to four things. We copy them outright:

| How dsh does it | Our counterpart |
| --- | --- |
| **Everything is a plugin** (288 packages, each registering one `ctx.*` service slot) | Channel, agent backend, device node, tools — all become plugins |
| **Patch file composition** (`cordis.patch.yml`: `id`/`name`/`config`/`disabled`/`insert`) | The same mechanism: the user's patch decides which plugins are installed and how they are configured |
| **Swappable seams** (`ctx.shell` can be sandbox or local; `ctx.llm` can be any provider) | `ctx.channel` (WeChat/Feishu/…), `ctx.device` (local/SSH/remote node), `ctx.agent` |
| **Layered profiles** (base patch + user profile patch, no cross-contamination) | Built-in defaults + user overrides |
| **Sessions/storage/permissions are also plugins** (`dsh-session-*`, `dsh-storage-*`, `dsh-authorization`) | Split apart the same way; especially **permissions/approval**, which must be productized as "ask one question in WeChat" |

**This is precisely the biggest gap right now**: today's code hard-wires two layers,
"bridge + backend," with no seam system at all.
To productize it, the first move is to stand up the three service slots `ctx.channel` /
`ctx.device` / `ctx.agent`.

---

## Milestones

| | Content | Acceptance |
| --- | --- | --- |
| **M0 ✅** | Channel layer works end to end: QR scan, send/receive, attachments, quotes, pluggable backend | Done; 19 offline tests at the time |
| **M1** | Channel layer becomes a real plugin (`ctx.channel` seam) + receiving images/files + `doctor` self-check + CI + bilingual docs | **This version is ready to open-source** |
| **M2** | Multiple terminals (LAN hub + nodes) + configuration inside WeChat | Two machines; saying "that file on the home computer" in WeChat retrieves it |
| **M3** | Non-technical-user installer (double-click install, onboarding-page QR scan, never asks for a key) + a second IM channel to validate the abstraction | A non-technical person completes install through use on their own |

---

## Explicitly Not Doing

- **Multi-user / shared use** — the positioning is "your own butler." Doing multi-user drags in identity, isolation, quotas, and abuse all at once, and it directly conflicts with "data never leaves your machine"
- **Hosted SaaS** — same as above
- **Reverse-engineering hooks into the WeChat client** — it breaks on every version bump, and the ban risk is high
- **General GUI automation (screenshots + simulated clicks)** — slow, brittle, hijacks your screen, and a single task can burn dozens of steps without succeeding. **Exception**: fixed-coordinate, single-purpose scripts (e.g. "send one WeChat message to someone")
- **Abstracting a "multi-channel gateway" while there is only one channel** — that is speculation right now. Wait until M3 has a real second channel, then abstract

---

## The Hard Problems (must be thought through now, no hand-waving)

1. **"Remote-control the computer" and "power it off" physically conflict.** Off is off.
   The product has to manage expectations: "the butler is online while your computer is on."
   Do not promise "always online."

2. **Non-technical users + local execution = security.** What the agent has is a shell on
   your machine. A non-technical user does not understand the risk, and **a config file
   can never be their line of defense**. There must be a productized approval mechanism —
   asking one question in WeChat, "run rm?", rather than making someone go edit `allowFrom`.

3. **Ban / compliance risk for personal WeChat.** Going through iLink (Tencent's own
   channel) is relatively low risk, but the product must state this honestly — it must not
   pretend the problem does not exist.

4. **Cost.** Behind one "butler" is continuous model invocation. Who pays decides whether
   this is an open-source tool or a commercial product. The answer to that question feeds
   back into the architecture (whether to build usage control, whether to build quotas).

5. **Cross-network traversal for multiple terminals.** See Fork 1. There is no free lunch:
   either the same LAN, or a relay.

6. **Voice is an unexpected gift.** WeChat's server has already transcribed voice to text
   (verified in M0), and non-technical users naturally prefer sending voice — this channel
   comes free.
