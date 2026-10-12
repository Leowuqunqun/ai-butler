# iLink Bot API 笔记

iLink 是腾讯给"个人微信号 + bot"开的通道（就是微信里那些扫码添加的 AI bot 背后那套）。
**没有公开文档。** 这份笔记是照着腾讯官方参考实现 + 本项目实测整理出来的：

- `@tencent-weixin/openclaw-weixin`（腾讯官方，v2.4.6）

下面每一条都标了是"官方实现里读到的"还是"实测的"。实测的东西版本可能会变。

---

## 1. 基本约定

| 项 | 值 |
| --- | --- |
| API base | `https://ilinkai.weixin.qq.com` |
| CDN base | `https://novac2c.cdn.weixin.qq.com/c2c` |
| App Id | `bot`（请求头 `iLink-App-Id`） |
| 客户端版本 | `(2<<16) \| (1<<8) \| 1` = `0x020101`（请求头 `iLink-App-ClientVersion`） |
| 鉴权 | `Authorization: Bearer <bot_token>` + `AuthorizationType: ilink_bot_token` |
| 防重放 | `X-WECHAT-UIN`：随机 uint32 的**十进制字符串再 base64**，每请求一个 |

```js
// X-WECHAT-UIN 的算法（不是 base64(4字节)，是 base64(十进制字符串)）
Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
```

> 实测：`X-WECHAT-UIN` 似乎不校验内容，随机即可。但格式要对，否则可能被拒。

---

## 2. ⚠️ 最重要的坑：HTTP 200 不代表成功

**iLink 用 `HTTP 200` + 响应体里的 `ret` / `errcode` 表达失败。**

```json
{ "ret": -1, "errmsg": "..." }
```

只判 HTTP 状态码会得到"发送成功"的假象——你的消息根本没发出去，而代码以为成功了。
**每个写操作都必须校验 `ret`/`errcode`。** 本项目的 `assertIlinkOk()` 就是干这个的。

---

## 3. 登录

### 取二维码

```
GET /ilink/bot/get_bot_qrcode?bot_type=3
```

**不需要任何鉴权。** 返回：

```json
{
  "qrcode": "<扫码用的 id>",
  "qrcode_img_content": "<要渲染成二维码的字符串>",
  "ret": 0
}
```

`qrcode_img_content` 是一个字符串，**必须自己渲染成二维码图片**（用 `qrcode` 之类的库）。

### 查询扫码状态

```
GET /ilink/bot/get_qrcode_status?qrcode=<qrcode>
```

```json
{ "status": "wait | scaned | confirmed | expired" }
```

`confirmed` 时才会带上凭据：

```json
{
  "status": "confirmed",
  "bot_token": "...",
  "baseurl": "https://...",
  "ilink_user_id": "oXXXX@im.wechat"
}
```

> **实测：单张二维码只活约 90 秒。** 文档/示例里说的 5 分钟不准。
> 所以"打印一张二维码图片让人扫"这个做法**必然失败**——你翻到手机再扫就过期了。
> 正确做法是在一个会**自动换码**的页面上呈现（见 `src/qr-page.mjs`）。
> 本项目实测的可用窗口是 85 秒（留了余量）。

> `baseurl` 要**存下来**，后续所有请求都可能要用它而不是写死的 base。

---

## 4. 收消息

```
POST /ilink/bot/getupdates
{ "get_updates_buf": "<上次返回的游标，首次传空串>" }
```

服务端会 **hold 住约 35 秒**（长轮询）。返回：

```json
{
  "ret": 0,
  "msgs": [ /* 消息数组 */ ],
  "get_updates_buf": "<新游标>"
}
```

**游标必须原样带回去**，否则会重复消费或漏消息。落盘保存。

### 过滤自己的消息

每条消息有 `message_type`：

```
0 = NONE   1 = USER（用户发的）   2 = BOT（bot 自己发的）
```

**只处理 `message_type === 1`。** 不判的话，bot 会把自己的回复当新消息收到，
然后回自己，无限循环。

### 消息体

```jsonc
{
  "message_id": "...",
  "from_user_id": "oXXX@im.wechat",
  "to_user_id": "...",
  "message_type": 1,
  "context_token": "...",        // 回复时带上
  "item_list": [ /* 见下 */ ]
}
```

`item_list[].type` 取值（官方实现 `dist/src/api/types.js`）：

```
0 NONE   1 TEXT   2 IMAGE   3 VOICE   4 FILE   5 VIDEO
11 TOOL_CALL_START   12 TOOL_CALL_RESULT
```

- **文本**：`type === 1` → `item_list[0].text_item.text`
- **语音**：`type === 3` → `item_list[0].voice_item.text`
  —— **微信服务端已经把语音转成文字了**，不需要自己接 ASR。
- `11/12` 是工具调用进度（配合 `run_id` 出站关联），本项目暂未使用。

### 收图片 / 收文件（加密 CDN 下载）

图片和文件**不是一个 URL，而是一组加密的 CDN 凭据**——要自己拼地址、下密文、再解密：

```jsonc
{
  "type": 2,
  "image_item": {
    "aeskey": "0123…ef",              // ⚠️ hex 串（16 字节 → 32 字符）
    "media": {
      "encrypt_query_param": "…",      // 下载凭据
      "aes_key": "…",                  // ⚠️ base64，见下表
      "full_url": "…"                  // 可选；有就直接用它
    }
  }
}
```

**下载**：`GET {cdnBase}/download?encrypted_query_param=<URL 编码后的值>`

**解密**：AES-128-ECB、PKCS7、**无 IV**，key 为 16 字节。

⚠️ **`aes_key` 有两种编码，真实流量里同时存在**——这是最容易搞错的地方：

| 编码 | 出现在 | 怎么认 |
| --- | --- | --- |
| `base64(16 字节原始 key)` | 图片 | base64 解码后长度 = **16** |
| `base64(32 字符 hex 串)` | 文件 / 语音 / 视频 | base64 解码后长度 = **32** 且全是 hex 字符 |

搞错的表现都一样：**消息收到了，但文件打不开**（解出来是乱码）。

⚠️ **图片还有第二个 key 来源**：`image_item.aeskey`（hex 串），
且它**优先于** `media.aes_key`。漏掉这个来源，图片就是乱码。

（出站那个坑正好与之对称：我们**发**文件时要把 key 写成 `base64(hex(key))`，见第 5 节。）

其他要点：

- `file_item` 额外带 `file_name` / `len` / `md5`。
- **没有 key 表示明文**，直接下，不要解密。
- 一条消息里可能有多个媒体项：只取一个（优先级 **图片 > 视频 > 文件**）。
- `ref_msg`（引用）里也可能挂着媒体，主 item_list 里没有时要回退过去取。
- 上限 **100MB**。
- 语音**不用下载**：服务端已经给了转写文本（见上）。

---

## 5. 发消息

```
POST /ilink/bot/sendmessage
Authorization: Bearer <bot_token>
```

```jsonc
{
  "msg": {
    "from_user_id": "",              // 发消息时留空
    "to_user_id": "oXXX@im.wechat",
    "client_id": "<自己生成的唯一 id>",
    "message_type": 2,               // BOT
    "message_state": 2,              // FINISH
    "item_list": [
      { "type": 1, "text_item": { "text": "你好" } }
    ],
    "context_token": "<可选，入站消息带过来的>"
  }
}
```

> **没有引用字段。** 出站结构里没有任何"引用某条消息"的能力，协议里消息也没有 id
> 可以用来引用。唯一存在的引用是**入站**的 `ref_msg`（第 7 节）。

### 发文件 / 图片 / 视频（三步，容易错）

**第一步：要上传地址**

```
POST /ilink/bot/getuploadurl
```

```jsonc
{
  "filekey": "<自己生成的唯一 key>",
  "media_type": 3,                        // 3 = FILE；发图片时这里是 1 (IMAGE)
  "to_user_id": "oXXX@im.wechat",
  "rawsize": 12345,                       // 原始字节数
  "rawfilemd5": "<原始内容的 md5 hex>",
  "filesize": 12352,                      // ⚠️ 16 字节对齐后的长度，不是 rawsize
  "aeskey": "<16 字节随机 key 的 hex>",
  "no_need_thumb": true
}
```

返回 `upload_full_url` 或 `upload_param`。有 `upload_param` 时自己拼：

```
https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=<...>&filekey=<...>
```

**第二步：上传密文**

把文件内容用 **AES-128-ECB + PKCS7** 加密，直接 POST 密文到上面的地址：

```js
const cipher = createCipheriv('aes-128-ecb', aesKey, null);  // aesKey 是 16 字节 Buffer
const encBody = Buffer.concat([cipher.update(data), cipher.final()]);
// POST encBody, Content-Type: application/octet-stream
```

取件凭据在**响应头** `x-encrypted-param` 里（个别情况下在 body 的 JSON
字段 `encrypted_query_param` 里，两个都兜住）。

**第三步：发出去**

```jsonc
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "oXXX@im.wechat",
    "client_id": "...",
    "message_type": 2,
    "message_state": 2,
    "item_list": [{
      "type": 4,                            // FILE
      "file_item": {
        "media": {
          "encrypt_query_param": "<第二步拿到的凭据>",
          "aes_key": "<base64(hex(aesKey))>",   // ⚠️ 见下
          "encrypt_type": 1
        },
        "file_name": "简历.pdf",
        "md5": "<原始内容的 md5 hex>",
        "len": "12345"                          // ⚠️ 字符串，且是原始长度不是对齐长度
      }
    }],
    "context_token": "..."
  }
}
```

> **`aes_key` 的编码陷阱**：是 `base64(hex(aesKey))`，也就是先把 16 字节 key 转成
> 32 个字符的 hex 字符串，再对这个字符串做 base64。**不是** `base64(aesKey)`。
> 搞错了表现为发送成功但对方收到的是坏文件。

> 文件上限 100MB。`getuploadurl` 失败时同样要看 `ret`。

#### 发图片：item 换成 `image_item`，而且 key 有**两个来源**

上传那三步一模一样，只有两处不同：`media_type` 写 **1**，第三步的 item 换成：

```jsonc
"item_list": [{
  "type": 2,                              // IMAGE
  "image_item": {
    "media": {
      "encrypt_query_param": "<同上>",
      "aes_key": "<base64(16 字节原始 aesKey)>",   // ⚠️ 跟文件**不一样**
      "encrypt_type": 1
    },
    "aeskey": "<同一个 key 的 hex 串>"              // ⚠️ 收信端**优先读这个**
  }
}]
```

| | 文件 / 语音 / 视频 | 图片 |
|---|---|---|
| `media.aes_key` | `base64(hex(key))`（32 个字符再 base64） | `base64(16 字节原始 key)` |
| 额外字段 | `file_name` / `md5` / `len`（视频只给 `media`） | `image_item.aeskey` = `hex(key)` |

**视频**跟文件同一档：`media_type` 写 **2**、item 是 `{ "type": 5, "video_item": { "media": {…} } }`，
`aes_key` 用 `base64(hex(key))`。注意**别顺手抄图片那一档的编码** —— 那是图片独有的。
（视频的时长/缩略图字段本项目没填：填了更好看，但不填也能发出去。）

这不只是为了对称好看：**入站解析图片时优先读 `image_item.aeskey`**（见第 3 节那个坑），
所以出站也照同一套写，两头才对得上。本项目两个来源都写，各自用它该用的编码 ——
对面读哪个都对。

> 判断"这个文件该当图片发吗"是**通道自己的事**：本项目按文件名（MIME 是 `image/*`）。
> Telegram 那条通道是同一条规矩（`sendPhoto` vs `sendDocument`），内核只说"把这个发给他"。

---

## 6. "正在输入"

```
POST /ilink/bot/getconfig   { "ilink_user_id": "...", "context_token": "..." }
  → { "typing_ticket": "..." }

POST /ilink/bot/sendtyping  { "ilink_user_id": "...", "typing_ticket": "...", "status": 1 }
```

> `status`：**1 = 开始输入，2 = 取消**（官方实现就是 `TypingStatus = { TYPING: 1, CANCEL: 2 }`）。
> ⚠️ 写 `0` 不会报错——HTTP 200、`ret: 0`，但微信那边毫无反应，属于静默失效。

---

## 7. 引用（入站有，出站没有）

入站消息的 text item 上可能带 `ref_msg`——当用户**引用**某条消息再发文字时：

```jsonc
{
  "type": 1,
  "text_item": { "text": "这是用户新打的字" },
  "ref_msg": {
    "title": "...",
    "message_item": { /* 被引用的那条消息的 item，可能是图片等媒体 */ }
  }
}
```

官方参考实现的处理方式（`dist/src/messaging/inbound.js`）：

```js
// 被引用的是媒体 → 只留当前文本
if (ref.message_item && isMediaItem(ref.message_item)) return text;
// 否则拼成一行前缀
return `[引用: ${parts.join(" | ")}]\n${text}`;
```

**注意：官方自己也只是把它压成一行纯文本，没有做任何结构化处理。**

出站**没有**对应能力。所以你想让 bot"引用着回复"是做不到的，
替代方案就是本项目的 `quoteReply`：回复开头自己带一行 `↩ 原问题`。

---

## 8. 其它零碎

- **`ret`/`errcode` 都要判**，不同接口用不同的字段名。
- 长轮询超时是**正常现象**，别当错误处理；真错误要退避重试（本项目 1s 起翻倍，封顶 60s）。
- 收消息时 `msgs` 可能一次给多条，逐条处理。
- `context_token` 是**每条入站消息**带的，回复时带上能让微信把消息归到正确的会话。
  不发也能发出去，但带上更稳。
- `client_id` 自己生成，用于幂等/去重，唯一即可。

---

## 9. 已知未做

- 出站**语音**：图片已经能发（第 5 节）；语音不是"把 `media_type` 改成 4"就行的 ——
  `voice_item` 里的音频得是 **SILK** 格式，塞个 wav/mp3 进去，对面只会看到一个放不出来的
  气泡。要做就得先有一个 SILK 编码器（纯 JS 的现成实现很少），所以先不做，也不假装支持。
- 收**语音的原始音频**：服务端已给转写文本，够用了；要音频得自己接 SILK → WAV 转码
- `item type 11/12` 的工具调用进度（配上 `run_id` 可以在微信里实时看到
  agent"正在读某个文件"，是个挺有意思的方向）
- 群聊
- 消息撤回 / 编辑
