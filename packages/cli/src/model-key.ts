/**
 * 当场验一把模型 key —— **在它被存下来之前**。
 *
 * 为什么非要有这一步：key 贴错了**不会报错**。它只会在几小时后表现为
 * "管家不回你"，而那时候用户早就不记得自己贴过什么了 —— 这是整条路上
 * 最难自己查出来的一种坏法。
 *
 * 所以我们拿这把 key 去问对方一句最便宜的话（列出可用模型），把结果分成三类：
 *
 *   ① **拿定了错**（401 不对 / 402 没钱）：不许存，当场说清楚。
 *   ② **能用**：存，说一句"能用"。
 *   ③ **没法确认**（网络不通、对方 5xx、次数太多）：**照样存**，但要说出来 ——
 *      否则他会以为验过了，回头去怀疑别的东西。
 */
export interface KeyVerdict {
  ok: boolean;
  /**
   * 拿定了的错才为 true（401/402/403）。
   *
   * `blocking: true` 表示"别存，让他在页面上改" —— 存一把错的等于埋一个哑雷。
   */
  blocking: boolean;
  /** 给用户看的一句话 */
  why: string;
  /** 可选：下一步该怎么办 */
  hint?: string;
}

export interface VerifyKeyOptions {
  /** 测试用。默认用 Node 自带的 fetch */
  fetch?: typeof fetch;
  /** 问哪个地址。默认 DeepSeek 官方（引导页告诉用户去拿 key 的也是它） */
  baseUrl?: string;
  /** 最多等多久。默认 6 秒 —— 这是"存一下"的动作，不能让人干等 */
  timeoutMs?: number;
}

/** 引导页让用户去拿 key 的地方，就是这里 */
export const DEFAULT_MODEL_BASE = 'https://api.deepseek.com';

const DEFAULT_TIMEOUT_MS = 6_000;

export async function verifyModelKey(key: string, opts: VerifyKeyOptions = {}): Promise<KeyVerdict> {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.baseUrl ?? DEFAULT_MODEL_BASE).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  try {
    const res = await doFetch(`${base}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: controller.signal,
    });
    return verdictOf(res.status);
  } catch (error) {
    // 连不上、超时、对方半路把连接掐了 —— 都**不能**当成"这把 key 不对"：
    // 冤枉一把好 key 比漏报更糟（用户会去重新申请一把，然后还是不通）。
    return {
      ok: false,
      blocking: false,
      why: '没能连上对方（网络不通或者太慢），没法确认这把 key',
      hint: '照常存下了。要是回头管家答不了话，再跑一次 butler run --again 换一把试试',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 状态码 → 人话。**这里只认"对方明确说了什么"**，其余一律归到"没法确认" */
function verdictOf(status: number): KeyVerdict {
  if (status >= 200 && status < 300) {
    return { ok: true, blocking: false, why: '这把 key 能用' };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      blocking: true,
      why: `对方说这把 key 不对（${status}）`,
      hint: '多半是没复制完整。回到 platform.deepseek.com → API keys，重新复制一整串（sk- 开头，别带空格）',
    };
  }
  if (status === 402) {
    return {
      ok: false,
      blocking: true,
      why: '对方说这把 key 的额度用完了（402）',
      hint: '去那个网站充点钱，或者换一把还有额度的 key',
    };
  }
  if (status === 429) {
    return {
      ok: false,
      blocking: false,
      why: '对方说现在请求太多（429）—— 没法确认，但 key 本身没被否掉',
      hint: '照常存下了。等一会儿再用就行',
    };
  }
  return {
    ok: false,
    blocking: false,
    why: `对方回了一个我看不懂的状态（${status}），没法确认这把 key`,
    hint: '照常存下了。要是管家答不了话，再跑一次 butler run --again 换一把试试',
  };
}
