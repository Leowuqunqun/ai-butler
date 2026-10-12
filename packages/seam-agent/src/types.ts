/**
 * `ctx.agent` 的值类型 —— 一问一答的输入输出。
 *
 * @module @butler/seam-agent
 */

import type { LocalFile } from '@butler/seam-channel';

/**
 * agent 要发回去的附件。
 *
 * 这里跟旧版命令行路径的一个**有意的区别**：旧版让 agent 在正文里写
 * `[[file:/路径|配文]]` 标记，由桥去解析。标记法能跑，但配文里出现 `|`
 * 就会解析错，而且类型上完全看不见——换到这里是显式字段。
 *
 * （agent 侧的提示词约定可以不变，转换由实现包负责。）
 */
export interface OutboundFile {
  /** 本机绝对路径 */
  path: string;
  /** 展示名。不给就取 path 的文件名 */
  name?: string;
  /** 跟着这个附件一起发的一句话 */
  caption?: string;
}

/** 一次提问 */
export interface AgentRequest {
  /**
   * 用户说的话。
   *
   * **有附件时，实现包通常已经在末尾附上了本机文件路径** ——
   * 所以哪怕后端完全不认识 `files`，也能靠读文件自己搞定。
   */
  text: string;

  /**
   * 附件（已由通道下载解密并落到本机）。
   *
   * 多数 agent 自己有读文件的工具，用不上这个字段；
   * 它是留给**一次性多模态后端**的（直接把图喂给视觉模型）。
   */
  files?: LocalFile[];

  /** 上次这条会话返回的 id，用来续接。首次为 `null` */
  sessionId?: string | null;

  /** agent 应该在哪干活（用户指定的工作目录） */
  cwd: string;

  /**
   * 长任务的进度回调。**可选**：实现方按自己的能力提供，
   * 没有就不调——不调不会让核心层认为你卡死了。
   */
  onProgress?: (line: string) => void;

  /**
   * 取消信号。**实现方应当尊重它**（尤其是拉起子进程的实现：
   * agent 一跑就是几分钟，用户改主意了不该只能等超时）。
   * 不支持取消的实现可以忽略，但要在自己的文档里说清楚。
   */
  signal?: AbortSignal;
}

/**
 * 机器可读的失败原因。
 *
 * 有它，核心层才能**按原因决定怎么恢复**，而不是去匹配错误文案
 * （匹配文案那种写法，改一个字就悄悄失效了）。
 */
export type AgentErrorCode =
  /**
   * 会话被占用/失效（同一个会话被别的进程打开了写句柄）。
   * 核心层收到它应当**丢掉旧会话、开一个新的重试一次**。
   */
  | 'SESSION_LOCKED';

/** 一次回答 */
export interface AgentResult {
  /** 会话 id，核心层会记住并在下一次续接 */
  sessionId?: string | null;

  /** 回给用户的正文 */
  text?: string;

  /** 要发回去的附件 */
  files?: OutboundFile[];

  /**
   * 失败原因。
   *
   * **失败必须说**：优先返回 `error` 而不是抛异常，核心层会把这句话
   * 如实转述给用户。静默失败是明确禁止的（用户只会看到"没反应"）。
   *
   * ⚠️ **下游请用真值判断（`if (res.error)`），别写 `=== null`。**
   * 这个字段是可选的：没出错的实现有的返回 `null`、有的干脆不写，
   * 两种都合法。写死 `=== null` 就会把后者误判成"没报错但也没结果"。
   */
  error?: string | null;

  /** 失败的类型（可选）。核心层按它决定怎么恢复 */
  code?: AgentErrorCode;
}

/** 实现方至少要能回答"我是谁" */
export interface AgentInfo {
  /** 例如 `'dsh'` / `'exec'`，用于日志与流水，不参与逻辑分支 */
  id: string;
  /** 人看的名字，例如 `'DSH headless agent'` */
  label?: string;
  /** 这个实现支不支持取消 */
  cancellable?: boolean;
}

/**
 * 一条自检结果。`butler doctor` 会把它原样打给用户看。
 *
 * ⚠️ 写的时候想着"用户看不懂技术"：`detail` 说**现在是什么状态**，
 * `fix` 说**该干什么**。别写 "token expired" 这种话，
 * 写"微信登录过期了，重新扫一下码"。
 */
export interface HealthCheck {
  /** 检查项的名字，会打在最前面，例如 `'微信登录态'` */
  name: string;
  /** 过了没有 */
  ok: boolean;
  /** 现在是什么状态。**过了也要写** —— "已登录"比一个光秃秃的勾有用得多 */
  detail?: string;
  /** 没过的话该怎么办。这一句决定用户能不能自己解决 */
  fix?: string;
}
