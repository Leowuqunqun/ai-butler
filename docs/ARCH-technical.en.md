# Technical architecture

[中文](ARCH-technical.md) | English

> For the product layer see [`ARCH-product.en.md`](ARCH-product.en.md) ｜ for the shape and the goals see [`VISION.en.md`](VISION.en.md)
> The diagram sources are in [`diagrams/`](diagrams/). The `.mmd` files are editable, the `.svg` files are rendered output.

**Note on the diagrams: their labels are still in Chinese.** This document links to the same diagram
files as the Chinese version; the sources are in the repo, so English versions would be welcome.

---

## At a glance

![Overall architecture](diagrams/arch-00-overview.svg)

The whole thing in one picture: **owner → channel servers (WeChat / Feishu / Telegram) → one cordis container (② conversation → seam → core → ③ capability / ④ devices → `state/`) → model service / other machines**.
The boxes inside the container are this repo's packages; each section below opens up one of them (source: [`arch-00-overview.mmd`](diagrams/arch-00-overview.mmd)).

---

## Design principles

1. **Copy dsh's skeleton, not dsh's complexity.**
   The seam split, patch composition, and dependency injection are all aligned with dsh;
   but **a normal user should never see a patch file** (that's for developers and advanced users).

2. **Only build a seam for things that have ≥2 real implementations.**
   WeChat + Feishu later → `ctx.channel` is worth it;
   only one device → `ctx.devices` is just an ordinary service, **not a seam**. No speculative abstraction.

3. **The agent runs on whichever machine the work happens on.**
   The hub only identifies people, routes, approves, and remembers — it **never reads files on a node's behalf**.

4. **Every failure must be told to the user in plain language.**
   Silent failure is product poison. Better to reply "I can't do this because X" than to play dead.

5. **Exactly one holder of the login state.** One IM account can have only one receiver. This is a hard constraint, not a choice.

---

## 1. System topology

### Single machine (the M1 shape — get this working first)

![Single-machine container](diagrams/tech-01-container.svg)

In single-machine mode the **hub embeds a local node** (same process, no Link) —
this is the M1 default shape, and the least fussy one.

### Multi-machine (M2)

![Multi-machine deployment](diagrams/tech-02-multimachine.svg)

> **The phone → computer hop needs no tunneling at all**: the phone goes through WeChat, the computer
> long-polls Tencent, and **iLink itself is that ready-made public relay.**
> Only **hub → other nodes** needs tunneling, and that goes over `ctx.link`.

---

## 2. Process model

| Process | Lifetime | Responsibility | Must it always be running? |
| --- | --- | --- | --- |
| **hub** | always resident | holds the IM login state; identifies people; sessions; routing; approval coordination; memory | ✅ Yes (shut it down and the butler is offline) |
| **node** | always resident | takes orders from the hub, runs the agent on this machine, touches files | ✅ Yes (otherwise that machine is uncontrollable) |
| **cli** | one-shot | login, self-check, debugging, sending a message | ❌ |

---

## 3. Package structure and seams

![Package structure and seams](diagrams/tech-03-seams.svg)

dsh's split is **"a seam interface package + independent implementation packages"** (`dsh-bash-local`'s
self-description is literally "the local subprocess implementation of the bash executor seam"). Copied:

```
packages/
├── core/                    # ✅ built: the kernel (identity / routing / queueing / progress / honest replies / memory / approval relaying / standing authorisation (optionally time-limited) / self-check (CLI + WeChat) / opener / memory auto-extraction, 166 tests)
│                            #    the two capability slots below are required; ctx.link is optional
├── seam-channel/            # ✅ built: the ctx.channel interface (TypeScript, 12 tests)
├── seam-agent/              # ✅ built: the ctx.agent interface (TypeScript, 12 tests)
├── seam-link/               # ✅ built: the ctx.link interface (TypeScript, 15 tests)
├── seam-approval/           # ✅ landed: the ctx.approval interface (TypeScript, 7 tests)
├── seam-memory/             # ✅ landed: the ctx.memory interface (TypeScript, 6 tests)
│
├── channel-wechat/          # ✅ M0 done; ✅ M1 wired into cordis (one package, two entry points, see below; 134 tests)
├── channel-telegram/        # ✅ M3: the second channel (pure `fetch`, zero deps, 51 tests).
│                            #    Its value is not the feature — it's the **proof that swapping IM
│                            #    needs no core changes**: only the `name` line in the config moved
├── channel-feishu/          # ✅ the third channel: Feishu/Lark (standing on the official @larksuite/channel; 83 tests; verified on a real tenant on 2026-10-14)
├── agent-dsh/               # ✅ extracted from M0: DSH headless (40 tests, 7 of them end-to-end)
├── agent-exec/              # ✅ extracted from M0: any command line (26 tests; also the contract's second check)
├── link-lan/                # ✅ built: direct connection on the same LAN (HTTP + SSE, zero dependencies, 65 tests)
│                            #    two entry points in one package: `@butler/link-lan` (hub) / `@butler/link-lan/node` (node)
├── link-tailscale/          # ✅ built: across networks (the roster is asked of Tailscale; the paired part is stored on disk; the wire protocol stays link-lan's HTTP + SSE, 34 tests)
├── approval-im/             # ✅ landed: asks the owner in the conversation (default; 18 tests, two entry points in one package)
├── approval-auto/           # candidate: for tests / automation (no real need yet, so not built)
├── memory-file/             # ✅ landed: a JSON file (9 tests; 0600 + atomic writes + order by seq, not by clock)
├── dsh-plugin/              # ✅ landed: packs the WeChat channel as a **DSH plugin** (37 tests + a real-tenant probe).
│                            #    imports no DSH package, depends only on services both profiles have, so it mounts
│                            #    under web or headless; one session per contact, resumable across restarts
│
├── hub/                     # planned: a standalone hub orchestration package — core/ fills that role today (same process on one machine)
├── node/                    # planned: a standalone device-node package — link-lan's /node subpath fills that role today
├── cli/                     # ✅ the `butler` entry point: config → install the container → go online (onboarding page) / doctor self-check (274 tests)
│                            #    includes M3's first piece: `butler init` (the program writes the config; the user types nothing; missing capability lines are filled in when upgrading an old config)
└── installer/               # half-landed: the script ships at the repo root (install.sh generates and double-clicks install.command, same origin as the CLI); the package isn't split out yet
```

**Naming convention** (learned from dsh): `seam-*` declares an interface only, no implementation; `<domain>-<implementation>` is a concrete implementation;
one package can **export several plugin entry points via subpaths** (that's exactly what dsh's `dsh-plugin-manager/tools` does).

> **Why not build all 5 seam packages at once**: an interface without an implementation is **guessed**.
> M1 has only two real implementations — `channel` (WeChat) and `agent` (dsh/exec) — so we only pin down those two;
> `link` (✅ 15 tests) and `memory` (✅ 6 tests) were only pinned down once a first implementation existed;
> `approval` has no implementation yet, so it is **still not pinned down**.
> This is the same principle as this project's "no speculative abstraction" — and it's exactly why
> `ctx.devices`/`ctx.sessions`/`ctx.store`/`ctx.audit` are **deliberately not seams**.

---

## 4. The seam contracts

![seam class diagram](diagrams/tech-10-class-seams.svg)

### Interface signatures (this is the contract — pinned down first)

> **The landed form is an `abstract class` (extending cordis's `Service`), not an `interface`** —
> that way a missing member in an implementation is a **compile-time** error, not something that blows up in production.
> `ctx.channel` has landed this way: [`packages/seam-channel/src/index.ts`](../packages/seam-channel/src/index.ts);
> the other domains are written exactly the same way, it's just not time for them to have an implementation yet.

```ts
// ── ctx.channel ─── ✅ landed (@butler/seam-channel) ────────────
abstract class ChannelService extends Service {
  abstract readonly id: string;                       // 'wechat'
  abstract start(): Promise<void>;                    // start receiving (polls/listens internally)
  abstract stop(): Promise<void>;                     // must be safe to call when never started
  abstract sendText(to: string, text: string, o?: SendOpts): Promise<SendResult>;
  abstract sendFile(to: string, path: string, o?: SendOpts): Promise<SendResult>;
  setTyping(to: string, on: boolean, o?: SendOpts): Promise<void>;  // best-effort, base class defaults to no-op
  onMessage(handler: (m: InboundMessage) => void): void;            // base class impl (dedupes the same handler)
  offMessage(handler: (m: InboundMessage) => void): void;           // base class impl
  protected emitMessage(m: InboundMessage): void;                   // for implementations to call; consumer throws are isolated
}
```

> **Three deviations from the first draft** (all forced by the implementation, not made up at a desk):
> 1. `setTyping` gained `o?: SendOpts` — WeChat needs a `typing_ticket`, which requires carrying `contextToken`,
>    so the draft's `(to, on)` simply does not work.
> 2. `interface` became `abstract class` — only by using cordis's `Service` do you get
>    "service slot registration / disposal on unload / `static inject` gating" for free.
> 3. `SendOpts` gained `quote?: string` — **forced by the second implementation** (see the section
>    below): WeChat can only prefix a line of text, Telegram has native replies, so the core passes
>    the raw text and the channel owns the rendering.

> **Three deviations of `ctx.agent` from the first draft** (likewise forced by the implementation):
> 1. **`requestApproval` was deleted.** No implementation uses it — approval is an M2 thing.
>    Leaving a field in the contract that nobody satisfies only makes people think "it's already supported".
> 2. **"Attachments to send back" moved from a markup convention to an explicit field.** The old CLI made the agent write
>    `[[file:/path|caption]]` in the body and had the bridge parse it; a `|` in the caption breaks parsing, and it's completely invisible to the type system.
>    Replaced with an explicit `OutboundFile[]` (**the prompt convention on the agent side is unchanged**; the implementation package does the conversion).
> 3. **`signal` and `code` were added.** `signal` because an agent run takes minutes — shutdown or a change of mind
>    can't just sit there waiting for the timeout; `code` because the core layer needs to **recover by reason**
>    (session locked → switch to a new session and retry once), rather than match error strings —
>    that string-matching style silently breaks the moment one character changes.

```ts
interface InboundMessage {
  channel: string;
  fromId: string;            // the user identifier inside the channel
  text?: string;             // text, or a voice transcript
  files?: LocalFile[];       // already downloaded locally (image/file) — the channel's job; the core layer only reads the path
  contextToken?: string;     // carried when replying (WeChat needs it)
  raw?: unknown;             // channel-private data, don't read it in the core layer
}

interface LocalFile {        // an attachment is always "a locally readable file", never a URL, never a Buffer
  path: string;              // absolute local path
  name: string;              // already sanitized, safe to display directly
  mime: string;
  size: number;
  kind: 'image' | 'video' | 'file' | 'voice' | 'unknown';
}
```

```ts
// ── ctx.agent ─── ✅ landed (@butler/seam-agent) ────────────────
// The contract **grew out of two backends that already worked**, rather than being drawn first and then forced onto implementations.
abstract class AgentService extends Service {
  abstract readonly id: string;              // 'dsh'
  readonly label?: string;                   // human-facing name (falls back to id)
  readonly cancellable: boolean;             // does this implementation support cancellation

  abstract run(req: AgentRequest): Promise<AgentResult>;
}

interface AgentRequest {
  text: string;                              // with attachments, the **local paths are already appended at the end**
  files?: LocalFile[];                       // reserved for a one-shot multimodal backend
  sessionId?: string | null;                 // continue a session; null the first time
  cwd: string;
  onProgress?: (line: string) => void;       // optional; not reporting is not treated as a hang
  signal?: AbortSignal;                      // optional; implementations that spawn a child process should support it
}

interface AgentResult {
  sessionId?: string | null;
  text?: string;
  files?: OutboundFile[];                    // an explicit field; no more [[file:]] markers in the body
  error?: string | null;                     // a failure must be stated
  code?: AgentErrorCode;                     // 'SESSION_LOCKED' → the core layer switches sessions and retries
}

// ── ctx.link ─── ✅ landed (@butler/seam-link; implementations: @butler/link-lan, @butler/link-tailscale) ──
abstract class LinkService extends Service {
  abstract readonly id: string;              // 'lan' | 'tailscale' | 'ssh'
  abstract discover(): Promise<DeviceInfo[]>;
  abstract connect(deviceId: string): Promise<LinkSession>;    // must **throw on the spot** if it can't connect
  pair?(target: PairTarget): Promise<DeviceInfo>;              // optional: adopt a new device (links whose roster is external don't need it)
  forget?(deviceId: string): Promise<'forgotten' | 'unknown' | 'static'>;   // optional: a verdict, not prose
  check?(): HealthCheck[];                   // optional; collected by doctor
}

interface DeviceInfo {
  id: string;                                // stable id: not a hostname, not an IP, not a random number
  alias: string;                             // the human-given name, e.g. "the one at home"
  os: string;
  capabilities: string[];                    // ['agent', 'files']
  lastSeen: number | null;                   // never heard from = null, not 0
  online: boolean;                           // "visible" and "reachable" are two things → two fields
  link: string;                              // which link saw it, e.g. 'lan'
}

interface LinkSession {
  readonly deviceId: string;
  request(method: string, params: unknown, opts?: LinkRequestOpts): Promise<unknown>;
  onClose(h: (reason?: string) => void): () => void;           // this link dropped
  close(): Promise<void>;
}

// progress **hangs off the request, not off the session** (see deviation 2 below)
interface LinkRequestOpts {
  onEvent?: (e: LinkEvent) => void;
  signal?: AbortSignal;
}

type LinkEvent =
  | { type: 'progress'; callId: string; line: string }
  | { type: 'done';     callId: string; result: unknown }
  | { type: 'error';    callId: string; message: string; code?: string };

// ── ctx.approval ───────────────────────────────────────────
interface ApprovalService {
  ask(req: ApprovalRequest): Promise<boolean>;   // timeout = false (no answer means don't do it)
}

// ── ctx.memory ─── ✅ landed (@butler/seam-memory) ─────────
abstract class MemoryService extends Service {
  abstract readonly id: string;                                  // 'file' / 'sqlite' / …
  abstract get(key: string): Promise<unknown>;                   // not remembered → undefined, never throws
  abstract set(key: string, value: unknown, meta?: MemoryMeta): Promise<void>;
  abstract list(filter?: MemoryFilter): Promise<MemoryEntry[]>;  // **newest first** (order is part of the contract)
  abstract forget(key: string): Promise<void>;                   // idempotent
}
```

> **Two deviations of `ctx.link` from the first draft** (again forced by the implementation):
> 1. **`interface` → `abstract class`.** Same reason as `ctx.channel`: only `Service` gives you
>    service-slot registration, teardown on unload, and `static inject` gating for free.
> 2. **Progress moved from a session-level `onEvent(h)` to a request-level `opts.onEvent`.**
>    The first draft hung progress off the whole session; with two calls running on one session,
>    every callback has to filter by `callId` itself — miss once and you get **crosstalk**
>    (A's progress shown against B's result). Hung off the request, crosstalk is impossible at the type level.
>
> Two types the first draft only named without giving a shape are now filled in: `DeviceInfo` and `LinkEvent`.
> Inside `DeviceInfo`, `online` and `lastSeen` **must stay separate**, because they answer two different
> questions: "can we see it" (it's in the list / on the wire) and "can we reach it" (we actually shook hands).
> `lastSeen` is how the user understands "offline" — you don't say "connection failed", you say
> "last online 3 hours ago".

### The second implementation: a different way to find machines, same contract (✅ landed, see `packages/link-tailscale`)

The second implementation of `ctx.link` is the **across-networks** one. What it proves is not
"another link was written", but **whether this contract survives a different implementation**:

| | `link-lan` | `link-tailscale` |
| --- | --- | --- |
| Where the roster comes from | `peers` in the config (hand-written) | Asked of Tailscale: who is on my network |
| Where the address comes from | A hand-filled LAN IP | A tailnet address (`100.x.y.z`) — survives network and IP changes |
| Who counts as "my node" | Anything configured | **Probe it**: only those that answer |
| The wire protocol | HTTP + SSE | **Still HTTP + SSE** — it reuses `LanSession` / `pingNode` directly |

Three conclusions:

1. **Only "discovery" forks; what should not fork did not.** The second implementation adds one
   step — asking for the roster; transport, authentication and frame parsing are all reused from
   `link-lan`. That is why it is installed **only on the hub** — the machine being driven still
   runs `butler node`, with not one character of its config changed.
2. **`LinkService` / `LinkSession` / the kernel's `route.ts`: not one line changed.** With the
   second implementation swapped in, everything the user can perceive must behave identically —
   the four M2 acceptance criteria in `cli/test/m2-e2e.mjs` **run as the same test cases against
   both links, with not one assertion changed** (the hub side simply swaps one plugin). That is the
   only real test of a seam: swap the implementation and the layer above never notices.
3. **The contract's "`check()` may return a Promise or be synchronous" was written casually at the
   time and paid off here.** A tailnet roster has to ask a CLI, so the self-check must be able to
   `await` — the contract needed no change.

There is also a **product-level fork** worth remembering here: `link-lan` takes its aliases from the
hub's config, while `link-tailscale` takes them from **what the node itself reports**. The
`DeviceInfo` shape is the same on both, so `@the-one-at-home` means the same thing on either link.

### How the user hands the second machine over (✅ landed: `pair` / `forget`)

The two sections above are about *finding* a machine. This one is about the **earlier step**:
how a machine **gets into the roster at all**.

The first draft put that step in the config — the user typed the same `secret` into two config
files. For a technical person that is nothing; for a **completely non-technical user that step is
the end of the road**: where is the file, do the quotes matter, what if I miscopy one character —
and all of those failures look like the same sentence: "it can't connect".

So it became pairing. And what changed is not just the flow but **who produces the key**:

| | First draft | Now |
| --- | --- | --- |
| Who generates the key | The user, copied into both sides | **The node itself** (generated on first start, stored in `~/.butler/node.json`, mode 0600) |
| What the user does | Edits two files, copies a random string | **Sends the line on that screen into WeChat** |
| How the key reaches the hub | The user copies it | **Fetched from the node** during pairing, over the LAN only |
| Blast radius of one leak | All machines (one shared key) | Only that one machine |

And "send that line into WeChat" hides two things that had to be thought through:

1. **The pairing code travels through WeChat; the key does not.** The user copies the code off
   another computer's screen, so it passes through Tencent's servers — which is why the code
   **works once only, dies after 5 wrong attempts, and expires in 30 minutes**. The long-lived key
   it buys travels **only over this one LAN link**, from the node to the hub. Miscopy it or have
   someone glance at it and the worst case is one failed pairing.
2. **Pairing is the only request that gets in without a key, and the red line still holds.**
   Normally it is `Authorization: Bearer <key>`; for pairing it is
   `x-butler-pair: <code>`. The node still decides **before reading the first byte**.
   **The credential changed; the ordering did not.**

`pair` / `forget` are **optional** methods on `ctx.link`, and that too was forced by an
implementation: the tailnet link **needs no pairing** (Tailscale owns the roster and both sides
already share a key), so it does not implement them — and the kernel must be able to tell it
"this link does not pair; say `devices` instead". **"Optional" is not laziness; there really is a
class of implementation that does not need it.**

`forget()` returns a **verdict** (`'forgotten' | 'unknown' | 'static'`), not prose: how to say
"this one is written in the config file, I cannot forget it" is the kernel's job (it knows what
the user should do next); the link only knows "this one is not mine".

### The second implementation: swap the IM, the contract stays put (✅ landed, see `packages/channel-telegram`)

`link`'s second implementation proved you can change *how machines are found*. The channel side has
to prove something harsher: **swap the IM and the core does not change a single character.**

The evidence is `packages/cli/test/switch-im.mjs`, which deliberately ignores Telegram's features
(those are the channel's own tests) and only looks at structure:

| Assertion | Why |
| --- | --- |
| The same `butler init --im telegram` + `butler doctor` | all four service slots stay green, `✓ channel @butler/channel-telegram` |
| `packages/core/src` contains **zero** channel package names | the day one appears, "swap the channel without touching the core" becomes a lie |
| Swapping IM does not scatter the home | `--config` pointing elsewhere moves the patch / dsh-home / channel state with it |

Exactly one thing actually changed: the `name` in that config line. `ctx.channel` resolves by
**slot**, not by name.

Three places where the contract genuinely fit (found while wiring it up, not designed in advance):

- **Quoting**: `SendOpts.quote` carries the raw *what is being answered*, while `contextToken` holds
  the message id Telegram needs — so one semantic has two renderings: WeChat prefixes a line,
  Telegram uses a native reply. **The core states the fact and does not decide how it looks** (the
  second implementation forced this out; see the section below).
- **Attachments**: the contract says an attachment must be a local file before it is emitted.
  Telegram needs two requests (`getFile` for the path, then the bytes), so the channel runs its own
  download worker while long-polling only receives.
- **Self-check**: `check()` returns `{ name, ok, detail, fix }`, so doctor needs to know nothing
  about Telegram — with no token the user reads "message @BotFather and send /newbot", not a
  validator's English.

**★ It exposed one real leak — and that leak is now fixed**: the outbound `↩ …` line is a **WeChat
shape** (the WeChat protocol has no reply field), yet it lived in the core (`quoteLine`), so a
Telegram user saw *the same sentence quoted twice*: the channel added a native reply and the core
still prefixed an `↩` line.

The fix hands rendering back to the channel through one new field:

```ts
interface SendOpts {
  contextToken?: string
  quote?: string      // what this message is answering (the raw text) — its looks are the channel's business
}
```

| Who | What happens now |
| --- | --- |
| The core | Passes the fact only: `{ contextToken, quote: msg.text }`, prefixing **nothing** (`quoteLine` is gone from the core) |
| `channel-wechat` | Prefixes a `↩` line — what users see is **exactly what they saw before** |
| `channel-telegram` | Uses a native reply; the text is untouched |
| Interim messages (progress, queue acks) | No `quote` → no quoting (quoting every "still working…" is just noise) |
| Terminal replies (answers, **errors**, refusals, command results, attachments and captions) | Always pass `quote` — the whole rule is one sentence: **terminal replies quote, interim messages do not** |
| An attachment-only message | Falls back to an attachment description (`[文件（报表.xlsx）]`) — "which file is this about" is what the user cares about |

Each channel's own tests pin one semantic with two renderings: WeChat asserts the text contains
`↩ …`, Telegram asserts `reply_to_message_id` is set **and** the text contains no `↩`.

**The inbound half is fixed too**: `InboundMessage.quote`. WeChat hangs it off the text item's
`ref_msg` (measured, see section 7 of `packages/channel-wechat/docs/protocol.md`), Telegram off
`reply_to_message`; each channel flattens it to plain text and the core sees one field.

| Who | What happens to an inbound quote now |
| --- | --- |
| The channel | Flattens it into `quote`; for quoted media it calls the seam's `quotedMedia()` (`[图片]` / `[文件（季度报表.xlsx）]`) — one shape, so the agent's context does not depend on which IM you use |
| The core · prompt | Prefixes it as context (`[引用: …]`) — with several messages in flight, the agent has to know what is being answered |
| The core · routing | **Body text only.** An `@device` inside the quote is not treated as addressing a device |

That last row is not fastidiousness; it fixes a bug you can actually hit: when the quote was merged
into the body, replying to an old sentence that contained `@device` sent *this* message to that
device for execution — while the user was merely quoting something they had said earlier. Commands
(`配对` / `设备`) read the body only for the same reason.

A side benefit for WeChat: `ref_msg` used to be **completely unhandled** (a user's quoted sentence
was silently dropped); now it really reaches the agent — on the **cordis plugin path**. The legacy
CLI entry (`bridge.mjs`, the `wechat-agent-bridge` command, still shipped) does not handle inbound
quotes to this day; it is slated to be folded into the core and deleted, so it was not patched.

One honest note to finish: the Telegram path is **not yet a non-technical path** — you have to paste
a `botToken` into the config yourself. The WeChat path is a QR scan (type nothing). Aligning them
means adding an input to the onboarding page; v1 ships as is.

### One package, two entry points (✅ landed, see `packages/channel-wechat`)

The WeChat channel is both a **command-line tool** and a **cordis plugin**, separated by `exports` subpaths
rather than split into two packages:

```jsonc
// packages/channel-wechat/package.json
"bin": { "wechat-agent-bridge": "src/cli.mjs" },
"exports": {
  ".":            { "types": "./src/plugin.d.ts", "default": "./src/plugin.mjs" },
  "./plugin":     { "types": "./src/plugin.d.ts", "default": "./src/plugin.mjs" },
  "./package.json": "./package.json"
}
```

```js
// Usage 1: command line, runnable today
//   $ wechat-agent-bridge run

// Usage 2: install it into the kernel as a plugin
import WechatChannel from 'wechat-agent-bridge/plugin';
await ctx.plugin(WechatChannel, { home: '/path/to/data' });
```

**Why not tear it down and rewrite it as a plugin.** The command-line path is **live** (it is really serving a WeChat account),
and "the rewrite will be better" is a gamble without regression coverage from a real account. So this round is **additive**:

| | Receive | Work | Send |
| --- | --- | --- | --- |
| `bridge.mjs` (command line) | ✅ | ✅ runs the backend itself | ✅ |
| `plugin.mjs` (cordis) | ✅ | ❌ hands it to the core layer | ✅ |

Both **share the same underlying modules** (`ilink` / `media` / `text` / `store`),
so there is only one protocol implementation — no two sets of logic drifting apart.
The "run the agent" part of `bridge.mjs` will naturally be replaced once the `ctx.agent` kernel is built.

> **One deliberate split line**: attachment **download** stays in the channel, but **not in the receive loop**.
> Inside the channel it's "long-poll loop → pending-download queue → download worker → `emitMessage`",
> so the `InboundMessage.files` handed out are always local paths already written to disk,
> and a slow download never drops the long-poll (dropping it means losing messages).
> How long the agent works after the download worker is none of the channel's business.

> **A real problem fixed along the way this round**: `stop()` used to wait for the in-flight long-poll to time out on its own,
> meaning `Ctrl-C` could hang for **40 seconds** at worst. Now the protocol layer accepts an external `AbortSignal`,
> so shutdown is immediate. Both paths — command line and plugin — were changed.

---

## 5. Down to code: dsh's plugin template (copied, verified)

In cordis **a plugin is just a Service subclass** — there's no `apply()` to write.
dsh's `dsh-bash-local` is the template:

**① the seam package — declares the interface only, no implementation**

```ts
// packages/seam-channel/src/index.ts   ← this file already exists, and 10 tests have run against it
import { Context, Service } from '@deepseek-ai/cordis';

// This line registers the service slot on Context — with it, consumers get the type of ctx.channel
declare module '@deepseek-ai/cordis' {
  interface Context { channel: ChannelService }
}

/** An abstract channel service. A subclass implements the abstract methods; loading the subclass as a plugin registers it as ctx.channel.
 *  A context can have only one implementation; loading a second throws (standard cordis behavior). */
export abstract class ChannelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'channel');          // ← the service name is pinned down here; subclasses only write super(ctx)
  }

  abstract readonly id: string;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendText(to: string, text: string, o?: SendOpts): Promise<SendResult>;
  abstract sendFile(to: string, path: string, o?: SendOpts): Promise<SendResult>;

  // ── non-abstract: the base class gives these to every channel for free ──
  async setTyping(): Promise<void> {}                       // defaults to no-op
  onMessage(h: (m: InboundMessage) => void): void { … }     // dispatch + dedupe
  offMessage(h: (m: InboundMessage) => void): void { … }
  protected emitMessage(m: InboundMessage): void { … }      // for implementations to call
}

export type * from './types.js';
export default ChannelService;
```

**② the implementation package — extends the seam base class, declares dependencies and config**

```ts
// packages/channel-wechat/src/index.ts
import z from '@deepseek-ai/schemastery';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@butler/seam-channel';

export class WechatChannel extends ChannelService {
  static inject = ['store'];            // which services I depend on (cordis waits until they're ready)
  static Config = z.object({            // my config, with validation and defaults
    botType: z.string().default('3'),
    maxReplyChars: z.number().default(1200),
  });

  readonly id = 'wechat';

  constructor(ctx: Context, public config: { maxReplyChars: number }) {
    super(ctx);
    // cleanup always goes through effect (cordis 4 has no 'dispose' event)
    ctx.effect(() => () => this.stop(), 'wechat.stop');
  }

  // …implement the abstract methods
}

export default WechatChannel;          // the default export is the plugin itself
```

**③ the seam package's package.json — pin the version contract with peerDependencies**

```json
{ "peerDependencies": { "@deepseek-ai/cordis": "~4.0.4" } }
```

**④ the kernel and the validation library (both the same as dsh's on public npm, verified to exist)**

| Package | Version | Role |
| --- | --- | --- |
| `@deepseek-ai/cordis` | 4.0.4 | plugin kernel (this is what dsh itself uses) |
| `@deepseek-ai/schemastery` | 3.18.4 | config schema; dsh uses it throughout |

> So "referencing dsh's architecture" is not a metaphor — it's **using the very same kernel**.
>
> ⚠️ One detail for your awareness: there are two kernel candidates — `@deepseek-ai/cordis@4.0.4` (what dsh uses,
> 100% identical behavior) and the upstream `cordis@4.0.0-rc.10` (more neutral, not tied to a vendor scope).
> **We suggest the former for now** (alignment first); if you later want out of the vendor scope, switch to upstream —
> the two share the same Service/Context model.

**⑤ Measured verification results — the differences hit while copying dsh (all run on this machine, not speculation)**

Each one was verified while writing `packages/seam-channel`. **The following items differ from the intuition you'd
get from "copying dsh's source"**, so they're recorded separately:

| Item | In dsh | Measured conclusion (what this project adopts) |
| --- | --- | --- |
| How the service name is registered | `super(ctx, "shell")` in the seam constructor | Same. **The service name is pinned down by the seam base class**; the implementation package only writes `super(ctx)` |
| Reading config | `this.config.timeoutMs.get()` | **Different**: in this project the parsed config is a plain value, so `this.config.maxReplyChars` is read directly. dsh writes it that way because it uses schemastery's `volatile()` |
| Teardown on unload | `ctx.effect(() => () => …, 'label')` all over the place | **cordis 4 has no `'dispose'` event** (`Events` contains only `internal/*`). Teardown can only go through `ctx.effect` |
| `ctx.plugin()` return value | — | Returns a **`Fiber`**: you can `await` it, but it is **not a `Promise` instance**, so `assert.rejects(() => ctx.plugin(…))` is rejected by Node |
| When a load failure surfaces | — | **Asynchronous**. Without `await` you never see it; it does **not** throw synchronously. Tests have to write `await assert.rejects(async () => { await ctx.plugin(Dup) })` |
| When `static inject` isn't satisfied | — | The plugin is **never constructed at all**. So the "service slot registered twice" error also only appears once the dependencies are all present |
| How to tell whether a service slot exists | — | **Do not use `'name' in ctx`**: cordis's Proxy `has` trap **still returns `true`** after the plugin is torn down (the property slot is kept). Always use a **value check**: `ctx.channel !== undefined` |
| A second implementation of the same service slot | — | Throws `service "channel" has been registered at <XxxChannel>`; it does **not silently overwrite** — this is exactly the guarantee behind "one context, one channel" |
| Can `static Config` stop a "missing required field" at compile time | dsh uses `z.object({ … })`, which can't stop it either (dsh itself only reports at runtime) | **It cannot.** The mechanism is as follows: a schemastery Schema **is callable**, which happens to satisfy cordis's `Plugin.Transform` (`Config: (config: S) => T`), so `static Config` really is the type source for `ctx.plugin()`; but its call signature is `(value?: S) => T \| null \| undefined`, the inferred `S` includes `undefined`, and `Spread<T> = undefined extends T ? [config?: T] : [config: T]` treats the config parameter as **optional** the moment it sees `undefined` ⇒ `ctx.plugin(P, {})` compiles. **Required fields can only be stopped by the implementation's own constructor at load time** (`agent-dsh` does exactly this; the error message names which field is missing and what it's for). A config **type error** (e.g. `patchFile: 123`) is still a compile-time error |

| Does a plugin have to be a `Service` | dsh has both kinds | **No.** A plain class, a plain function, or an async function all work as plugins: `static inject` gating and `static Config` apply just the same, and `await ctx.plugin()` really does wait for an async function to finish (measured: it slept 60 ms inside, and the `await` waited the full 63 ms). This project **still prefers `Service`** (service-slot registration comes free), but if it needs to be "ready" you must give it an explicit `start()` — **a constructor cannot await**, and starting inside the constructor leaves a window where it has "announced itself online" while the port is not open yet (`butler node` handles it exactly this way: the CLI calls `ctx.node.start()`, mirroring how `run` calls `core.start()`) |

> In one sentence: **"copying dsh" means copying the structure (seam package + implementation package + `static inject`/`Config` + `export default`),
> not the API usage word for word.** All the differences above are already frozen into tests
> (every seam package, every implementation package).
> ⚠️ The **current** per-package case counts are not copied into this document — they are
> maintained in exactly one place: the "Tests" section of the [project home](../README.en.md).
> Copying them here means they drift apart (this line has drifted before).

---

## 6. Configuration and composition (**semantics** copied from dsh, **file syntax** simplified)

![Config layering](diagrams/tech-04-patch-layers.svg)

> ✅ **Landed.** Implementation: `packages/cli/src/config.ts` (overlay semantics) and `boot.ts` (loading).

```json
{
  "plugins": [
    { "id": "channel-wechat", "name": "wechat-agent-bridge/plugin", "config": { "botType": "3" } },
    { "id": "agent", "name": "@butler/agent-dsh", "config": { "profile": "headless" } },
    { "id": "core", "name": "@butler/core", "config": { "workspace": "/the/directory/you/want/it/to/manage" } },
    { "id": "link-tailscale", "name": "@butler/link-tailscale", "disabled": true }
  ]
}
```

**The semantics we kept (these are the ones that really matter, and tests nail every one of them)**:

- A row is addressed by `id`, and **a later row's whole config overwrites the earlier one** (it's a **whole replacement**,
  not a deep merge → so defaults must be spelled out in full in the base)
- `id` doesn't exist → append (equivalent to dsh's `insert`)
- **Row order carries no semantics**
- The base composition is applied to the empty root as **one overlay**; the user's patch stacks on top of that

**What got simplified is the file syntax — two things, both with reasons**:

| Simplification | Reason |
| --- | --- |
| JSON, not YAML | one fewer dependency; and the primary author of this file is the onboarding page/GUI, which needs machine read/write anyway |
| No `- insert:` envelope | "insert" is currently the only operation, so the envelope carries no information |

> ⚠️ **One deliberate security deviation: `disabled` only accepts `true`/`false`; dsh's `!!js "expression"` is not supported.**
> That amounts to `eval`-ing arbitrary code in a config file. For a product "used by people who don't understand
> technology at all", that is a pure foot-gun — the cost (one less bit of flexibility) is far smaller than the benefit
> (one less entry point for arbitrary code execution). When you really need conditional enabling, let **the plugin itself**
> decide based on config, instead of giving the config file execution power.

### A trap that looks like it's caught at compile time

Required config **cannot be caught at compile time**. A schemastery Schema is callable, which happens to satisfy cordis's
`Plugin.Transform` (`Config: (config: S) => T`), so `static Config` really is the type source for
`ctx.plugin()`; but its call signature is `(value?: S) => T | null | undefined`,
the inferred type includes `undefined`, and `Spread<T> = undefined extends T ? [config?: T] : [config: T]`
treats the config parameter as **optional** the moment it sees `undefined` ⇒ `ctx.plugin(P, {})` compiles.

**So required fields can only be stopped by the implementation's own constructor at load time** (`agent-dsh` / `agent-exec`
both do this; the error message names which field is missing and what it's for). A config **type error**
(e.g. `patchFile: 123`) is still a compile-time error.

### How it composes into a runtime at startup

![Boot composition](diagrams/tech-12-boot.svg)

**Three layers of configuration**:

| Layer | Location | Who writes it |
| --- | --- | --- |
| ① built-in composition | `butler-base/cordis.patch.yml` | shipped with the package |
| ② user override | `~/.butler/cordis.patch.yml` | **the onboarding page / the WeChat conversation** writes it |
| ③ runtime state | `~/.butler/state/` | the program writes it itself (login state, sessions, memory) |

> ⚠️ **Key principle: align the architecture with dsh, but never expose dsh's complexity to non-technical users.**
> A non-technical user just clicks a few times on the onboarding page and says a few sentences in WeChat;
> the patch file is **an escape hatch for developers and advanced users**, not the product interface.

---

## 7. Key flows

### 1. A normal inbound turn

![Inbound turn sequence](diagrams/tech-05-seq-inbound.svg)

The point: **the receive loop is never blocked by the agent**; work is strictly serial + queued; long tasks report progress periodically.

### 2. Approval

![Approval sequence](diagrams/tech-06-seq-approval.svg)

### 3. The approval state machine

![Approval state machine](diagrams/tech-09-state-approval.svg)

### 4. Cross-device (✅ implemented, see `packages/core/src/route.ts`)

![Cross-device sequence](diagrams/tech-07-seq-multidevice.svg)

The core decides the route at its **single seam** (the step that hands the words to an agent):
**local by default, cross-device only when asked explicitly.**

| What the user types | Which path it takes |
| --- | --- |
| `tidy the desktop` | `ctx.agent.run(...)` — this machine |
| `@the-one-at-home tidy the desktop` | `ctx.link.connect('node-home')` → `agent.run` on the other side |
| `the one at home seems broken` | this machine. **That is talk, not a command** |

> ⚠️ **Why "the device name appears in the sentence" must not count as cross-device.**
> That is not cleverness, it is danger: the owner says "the one at home seems broken", and
> implicit matching treats that **sentence** as a **command** and ships it to that machine to
> be executed — where it really starts doing things. Implicit intent recognition can come later
> (letting the agent decide which machine to call), but **the default path has to be
> deterministic**.
>
> The price is that the user learns one symbol (`@`). We accept that price, because what it buys
> is a rule **the user can reason about themselves**.

Three conventions that live in the implementation and are pinned by tests:

1. **No `@` means not a single network call.** `discover()` is only called when an `@` is seen —
   the overwhelming majority of messages take the zero-cost path.
2. **Alias cutting prefers the longest known alias.** Chinese often omits the space
   (`@the-one-at-hometidy the desktop`), so match against known aliases first and only fall back
   to "the first word after `@`".
3. **Sessions are recorded per "person + which machine"** (`node-home#u1` / `u1`). The local entry
   keeps its old key so an already-running butler does not lose its sessions on upgrade.

**Not delivered ≠ delivered and failed.** The two are answered differently: the former must never
be written as "(agent error)" — the agent never even heard the words, and saying so sends the user
looking in the wrong place.

#### How a file produced on the other machine gets back: mint a pickup token

M2's acceptance sentence is "say 'the file on the home computer' in WeChat and **you can get it**".
There is one physical fact in the way: **that path does not exist over here.** Passing the path
through means WeChat goes looking for a file that isn't there.

So the link carries **tokens, never paths**:

```
node agent produces   files: [{ path: '/home/leo/report.xlsx', name: 'report.xlsx' }]
      ↓ the node keeps a token → path slip (in its own memory only, expires in 10 min)
across the link       files: [{ token: 'a3f…', name: 'report.xlsx' }]
      ↓ the hub calls file.read with that token, in 512 KiB chunks
hub                   local temp file → ctx.channel.sendFile
```

> ⚠️ **Why not "the hub names a path and the node reads it back".**
> That would turn this into an interface for **reading any file on that machine**, when all it needs
> is "hand over the few files the agent just produced". The difference is not fastidiousness: if the
> secret leaks once on a LAN, the former throws the whole machine open while the latter costs one
> extra round of confirmation. Here **can we** and **should we** point the same way — letting tokens
> be minted only from agent output shrinks the attack surface until it is not worth discussing.
>
> A bonus: chunked pickup makes progress reporting like "fetching report.xlsx (63%)" possible, so
> the user does not think it has hung.

Two rules that do not bend: **it counts only once it has arrived** (files that fail to come back are
named in the reply, and it never pretends they were sent), and **no half files** (a transfer that
breaks midway is deleted; an error beats sending a truncated file as if it were good).

### 5. Receiving images / files (✅ implemented, see `packages/channel-wechat/src/media.mjs`)

![Receiving media sequence](diagrams/tech-08-seq-media.svg)

iLink's inbound media is **not a URL but an encrypted CDN credential**; it must be downloaded + decrypted:

```
item_list[i].image_item / file_item
   media: { encrypt_query_param, aes_key, encrypt_type, full_url? }
   │
   ├─ ① assemble the download URL (if full_url is present, just use it)
   │     `${CDN}/download?encrypted_query_param=${encrypt_query_param}`
   │
   ├─ ② get aes_key —— an image has **two sources**, and image_item.aeskey wins:
   │     image_item.aeskey (hex string)  ← image-specific; miss it and you get garbage
   │     media.aes_key                   ← generic fallback
   │
   ├─ ③ parse aes_key —— ⚠️ both encodings exist in real traffic at the same time:
   │     base64(raw 16 bytes)            ← images
   │     base64(hex string, 32 chars)    ← files / voice / video
   │     (the test: after base64-decoding, a length of 16 is the former, a length of 32 and all hex is the latter)
   │
   ├─ ④ download the ciphertext → AES-128-ECB decrypt (no key means plaintext, just download it)
   │
   └─ ⑤ save to state/inbox/<time>-<safe-file-name> → hand the **local path** to the agent
```

> This foot-gun is exactly symmetric with the **outbound** one: when writing a file outbound, `aes_key = base64(hex(key))`.
> Not knowing this shows up as "the image arrived but won't open".

Two deliberate boundaries:

1. **Download happens in the work loop, not the receive loop.** You still have to be able to receive new messages while a 100MB file is coming down.
2. **The bridge only saves the file locally; it doesn't understand it for the agent.** What's handed to the agent is an ordinary path —
   it looks at the image itself and parses the xlsx itself. Swapping models or backends never affects whether attachments work.

---

### 6. The first run: from an empty directory to a working butler (✅ M3: `init`, the installer and autostart have all landed)

On an empty machine, four things happen in order, and **the program does every one of them,
not the user**:

| Step | Who | Artifact | Without it |
| --- | --- | --- | --- |
| `butler init` | the program writes the config and the patch | `~/.butler/config.json`, `~/.butler/dsh.patch.yml` | the user hand-assembles four plugin names and absolute paths; get one character wrong and the symptom is "it will not load" |
| paste the model key | **the user** (one input box; the only one or two hands-on steps on the whole path) | `<dsh-home>/.credentials.yaml` (0600) | it used to mean hand-writing provider / baseURL / models in YAML — **a non-technical user cannot** |
| paste the channel token (**Telegram only**) | **the user** (the same page asked differently: one input box) | `<butler dir>/state/secrets.json` (0600) | it used to mean opening `config.json`, finding the channel row and filling in `botToken` — **a non-technical user cannot** |
| `butler run` ① | load four plugins → bring up an **onboarding page** bound to loopback only (with a one-time nonce), open the browser, wait for the key, write the credential store | the model key | this used to mean editing the provider in the patch: that step was the end of the road |
| `butler run` ② | the channel brings up its own QR page, opens the browser, waits for the scan, persists → go online | the WeChat login state | this used to just error out and tell you to run some other command (a name you cannot guess) |
| say the first sentence in WeChat | the user | ownership is claimed | — |

Three design constraints:

1. **Only `init` writes files.** With a missing config, `run` / `node` write nothing and ask
   nothing — they hand you one command you can copy. That keeps them read-only: testable, and
   they will not quietly change your home while you are debugging something else.
2. **Only missing files are written.** A second `init` touches not one byte (the user may have
   added devices or changed directories already).
3. **The model key is not in either file.** It lives in DSH's own credential store, so this path
   **never asks for a key** — the patch keeps the *name* of the env var (`apiKeyEnv`), not the key.

> "Loaded" and "online" are two distinct steps: plugins being loaded does not mean the thing is
> online. The channel's `start()` may be waiting for someone to scan, and the error it throws
> (scan timeout / user cancelled) has to be caught at the CLI layer — the first becomes one plain
> sentence, the second is not treated as a failure at all (exit code 0).

### 6.1 The installer: compressing the non-technical user's first run into "three steps" (✅ landed)

`install.sh` is a **bootstrapper**, not "Node baked into one binary" — the butler works through
`dsh`, and `dsh` is itself a Node program, so embedding a runtime still requires one on the
machine. The right shape is therefore **check → download → install → open the onboarding page**.

| Step | What it does | Why that way |
| --- | --- | --- |
| ① Node | use what the machine already has (≥ 20); otherwise download a **pinned** official build, **verify its SHA256**, unpack to `~/.butler/runtime` | never `latest`: the result must be reproducible or the checksum means nothing. **No root, ever** |
| ② Install | the 11 tarballs go into **one private dependency tree** at `~/.butler/prefix/app`, then the command is linked to `<prefix>/bin/butler` | see the bug below |
| ③ PATH | print the line to add (only `--add-path` writes it, and idempotently) | never edit a user's dotfiles behind their back |
| ④ Start | `butler run` (the browser opens the onboarding page). `--uninstall` **keeps** the config and login state in `~/.butler` | uninstalling is not deleting your stuff |

**★ The bug the clean-room acceptance caught on its very first run**: the 11 packages were
originally installed with `npm i -g *.tgz` — npm treats each as an **independent global
package** and nests its dependencies under it, so `@butler/agent-dsh` could not see the
neighbouring `@deepseek-ai/schemastery` and three of four plugins failed to load. Installing
**one private dependency tree** (the exact shape a published `npm i -g @butler/cli` produces)
turned everything green. **Only a real install exposes this class of bug**, so
`scripts/verify-clean-install.sh` is now a standing acceptance: it builds the very
`dist/*.tar.gz` that ships, unpacks it, and walks "dry-run → real install → `--help` → `init`
→ `doctor` → `autostart --dry-run` → uninstall keeps data" inside a **temporary home and prefix**.
(The **upgrade** path is a second standing acceptance, `scripts/verify-upgrade.sh`: install a real
old release, let the **old CLI** write the config, drop in the things a user would have edited, then
upgrade in place with the **published** new `install.sh` — "clean machine, first install" can never
tell you whether the things in a **lived-in house** survived.)

That chain has since caught two more, both living exactly where "only happens once you ship it"
lives — and both are now pinned in the script:

· The shipped `README.txt` printed the **packaging machine's** absolute path (`cd "$(pwd)"` is
  evaluated **at packaging time**) — the recipient copies it and the directory does not exist.
  It now says "drag the folder into the terminal", and the packaging script has a gate of its own:
  if the packager's path ever leaks in, the bundle is not produced.
· On a machine that has just been installed and not configured at all, `doctor` said "fix this
  config file" — when there is **no file**. A missing file and a broken file are two different
  things: the former now hands over the one copy-pasteable line, `butler init`.

**CI is the same story**: since it cannot be pushed to GitHub, every CI step was run on a clean
local copy (no `node_modules`, starting from `pnpm install --frozen-lockfile`). That caught the
workflow specifying `version: 10` for `pnpm/action-setup` while `package.json` carries
`packageManager: pnpm@10.32.1` — two sources of truth, and the first push could have gone red.
There is now a single source, `packageManager` (which is also the exact version the lockfile
corresponds to, rather than any 10.x).

**One page engine, two questions**: the model key (stored in DSH's credential store) and
channel credentials (stored in `state/secrets.json`). The wording follows **the specific
thing** being asked for (where to get a key and where to get a token are not remotely the
same), but **the security-relevant code exists exactly once** — duplicating the one-time
nonce, the loopback-only bind or the body cap is how you eventually get a hole.
Precedence: hand-written in the config > stored by the onboarding page > ask once; `doctor`
reads the same rules (read-only, never opens a page), so it cannot contradict `run`.
`butler run --again` means "**ask me once more**", not "wipe and start over": if the user
skips (or just closes the page), the old credential must keep working — otherwise the very
act of rotating a key could silence the butler.
⚠️ This gate must finish **before** the container is built: a plugin's `config` is read at
construction time (which is why `boot()` grew a `rows` parameter).

Autostart (`butler autostart on|off|status`) has two traps, both handled inside the unit file:
it carries **the PATH you have now** (the one the OS hands out at login has no `dsh` in it, and
`dsh` is what the butler thinks with), and the command carries `--no-open` (otherwise every
login pops a browser). On Windows it **honestly says "not done yet"**.

**Deliberately not done**: `.dmg` / `.exe` need an Apple ($99/yr) and a Windows code-signing
certificate, or Gatekeeper / SmartScreen blocks them outright — that is an account-and-money
problem, not a technical one.

## 8. Data model

![Data model](diagrams/tech-11-er-state.svg)

Everything lands in `~/.butler/state/` (**never in the repo**):

| File | Contents | Sensitivity |
| --- | --- | --- |
| `owner.json` | the owner's identity (channel + userId + bind time) | medium |
| `token.json` | IM login state | **⚠️ equivalent to an account password** |
| `devices.json` | device registry: id, alias, OS, capabilities, last online, link type | low |
| `sessions.json` | `(channel, fromId, deviceId)` → agent sessionId | low |
| `memory.json` | preferences / facts / authorizations | **high (contains private data)** |
| `approvals.jsonl` | approval records (who approved, what was approved) | medium |
| `audit.jsonl` | send/receive log | medium |
| `pending/` | pending approvals (with timeouts) | medium |

**The session key is a triple**, not a pair — because the same person on different devices may have different context
("that file" on the home computer vs the work computer may mean different things).

---

## 9. Technology choices

| Item | Choice | Reason | Status |
| --- | --- | --- | --- |
| Runtime | **Node ≥ 20, ESM** | verified in M0; cross-platform | ✅ decided |
| Plugin kernel | **`@deepseek-ai/cordis` 4.0.4** | composition/patch/dependency injection all for free — this is what "referencing dsh" means | ✅ decided |
| Config schema | **`@deepseek-ai/schemastery` 3.18.4** | dsh uses it throughout | ✅ decided |
| Language | **TypeScript** | the core value is "a plugin ecosystem for others to use", and types are the interface contract | ✅ decided |
| Config | cordis patch (YAML) | align with dsh | ✅ |
| IM | iLink (WeChat) | verified in M0 | ✅ |
| Across networks | Tailscale / LAN | we run no servers of our own | ✅ decided |
| Storage | JSON to start (✅ memory already landed this way: `memory-file`, 0600 + atomic writes) → SQLite | keep it simple first; switch when memory/log volume grows | ✅ |
| Model | the user brings their own key | zero cost to us, best privacy | ✅ decided |

**The landing convention for TypeScript** (aligned with dsh's package shape):

```
packages/<name>/
  src/            ← source (TS)
  lib/            ← build output: lib/index.js + lib/types/**/*.d.ts
  package.json    ← "main": "lib/index.js", "types": "lib/types/index.d.ts"
                    "exports": { ".": { "types": ..., "default": ... } }
                    "publishConfig": { "access": "public" }
  tsconfig.json   ← inherits the root tsconfig.base.json
```

The `.d.ts` **is the interface contract itself** — it's what others look at when they wire up a plugin.
So the types in `seam-*` packages have to be right the first time; changing them is a breaking change (and must follow semver).

---

## 10. Deployment and running

| Shape | How to run it | For |
| --- | --- | --- |
| **development/debugging** | `pnpm build && node packages/cli/lib/cli.js run` | you and me |
| **always-on** | launchd (macOS) / systemd (Linux) | developers |
| **non-technical users** | the installer installs it as a service + the onboarding page (M3) | the target user |

**It must be installed as a system service, not run under nohup.** We hit this in M0: a process started from a shell
(especially from inside a sandbox) brings nested-sandbox problems, and it won't start on boot. Installing it as a
launchd/systemd service **solves both of those** as a side effect.

---

## 11. Failures and degradation

| Failure | Symptom | Handling |
| --- | --- | --- |
| The machine the hub runs on sleeps/shuts down | the butler is fully offline | say so honestly; **we don't promise to always be online** |
| A node is offline | that device is uncontrollable | just say "that computer is offline right now" + its last-online time; don't force it |
| IM long-poll drops | no messages come in | back off and retry (start at 1s, double, cap 60s); the cursor is persisted, so no messages are lost |
| A model call fails | the work fails | relay the error verbatim; **never fail silently** |
| Model timeout | stuck | hard timeout and cut it off + tell the user "it ran Ns with no result; rephrase it or split it smaller" |
| agent infinite loop | burning tokens | timeout + a step budget; the persona explicitly says "stop and report if two attempts make no progress" |
| Approval goes unanswered | stuck | **timeout = rejection**; never wait forever (M0 measured a 3-minute hang) |
| Two messages at once | the flavors bleed together | receive/work separation: the receive loop is never blocked by the agent; work is strictly serial + a queue notice |
| The session is locked by another process | continuing fails | automatically switch to a new session and retry once (done in M0) |

### How the user finds out which one happened: `butler doctor`

The table above is all about "what the program should do". But what really decides whether this product is usable is
**whether the user has a clue when something goes wrong**. The worst experience this product can give isn't an error — it's **no response at all**.

So every layer can be asked on its own "are you OK right now", and the answer is meant for a human:

```
Self-check
  ✓  data directory        /Users/me/.butler
  ✗  WeChat login state    this machine has never logged in
      → it prints a QR code at startup; just scan it with WeChat
  ✓  dsh executable        /usr/local/bin/dsh
  ✗  dsh patch file        /Users/me/.butler/dsh.yml does not exist
      → this file holds the model channel and the persona; without it nothing gets done; point patchFile in the config at the right one
  ✓  who can command it    ownership claimed (the first person who talked to it). If anyone else messages it, it goes silent
```

**The convention: an optional `check?()` on the seam.**

```ts
abstract class ChannelService extends Service {
  /** Optional. Every entry returned shows up verbatim in `butler doctor`'s output */
  check?(): Promise<HealthCheck[]> | HealthCheck[];
}
```

Same name and signature on `ctx.agent`. `HealthCheck = { name, ok, detail?, fix? }`.

**Why it lives on the seam instead of letting doctor probe from outside**: only the implementation itself knows what to check —
the WeChat channel knows where the login state lives, dsh knows which binary and which patch file it needs,
exec knows whether `argv[0]` exists. Making doctor guess would mean copying every implementation's config schema,
which is a maintenance disaster and a layering error.

**Three conventions** (written into both seams' READMEs; all four implementations follow them):

- **Don't throw.** If something really goes wrong, return an `ok: false` entry that explains the situation.
- **Don't do heavy work.** Only check preconditions — no real tasks —
  a user will run the self-check every single time they hit "no response".
  **The one exception is a single time-bounded liveness probe** (Telegram's `getMe`: is this
  token still accepted?). It catches something no file inspection can: "it worked yesterday,
  today it doesn't", caused by the token being revoked on the other side. It must be
  **bounded** and **must not treat "can't reach the network" as a failure** (say "not checked
  this time", still `ok: true`) — otherwise an offline machine sends the user chasing a
  problem that does not exist.
- **`detail` states the status, `fix` states the action.** Even `ok: true` gets a `detail`
  ("logged in, scanned the code on March 2" is more useful than a bare checkmark).

**Four engineering constraints** (all of them went into tests):

| Constraint | Why |
| --- | --- |
| `check?()` must be **optional** | adding this convention must not make existing implementations invalid. A test directly asserts that `ctx.channel.check === undefined` when it isn't implemented |
| doctor **never throws** | the user running this means something is already broken; if the diagnostic tool blows up too, there's nothing left. Unreadable config, broken JSON, a plugin's own self-check throwing — all get caught and turned into check entries |
| doctor has **zero side effects** | it only loads, never starts. A test asserts `core.start()` was never called |
| every failing check **must carry a `fix`** | that one sentence decides whether the user can solve it themselves — it's the entire reason this tool exists |

> **One newly discovered runtime fact**: a test like `ctx.channel.check === undefined`
> **must not** be written as `'check' in ctx.channel` — see the measured conclusion in section 5's table (near the end)
> about `name in ctx` still being true after unload. The same goes for whether a service slot exists:
> always **test by value**.

---

## 12. Correspondence with dsh: what we copied and what we didn't

| What dsh does | Us |
| --- | --- |
| seam package + implementation package split | ✅ copied |
| patch file composition (id/name/config/disabled, last-write-wins) | ✅ semantics copied |
| cordis kernel + schemastery config | ✅ adopted directly |
| profile layering (base + user override) | ✅ copied |
| sessions / storage / permissions are all replaceable services | ✅ copied |
| one package, many entry points (`pkg/tools` subpath) | ✅ copied |
| **a developer-facing Web GUI client** | ❌ not doing it (WeChat is the only UI) |
| **an account system / multi-tenancy** | ❌ not doing it (single-person product) |
| **exposing patches to normal users** | ❌ **this is the most important difference** |
