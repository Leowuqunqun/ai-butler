/**
 * echo 后端 —— 不调用任何模型，把问题原样回给你。
 * 用途：验证微信通道本身通不通（扫码、收发、附件、引用），把 agent 这一层排除掉。
 */

export default {
  name: 'echo',

  async run({ text, sessionId }) {
    return {
      sessionId: sessionId ?? 'echo-session',
      text: `（echo 后端，未接模型）收到：${text}`,
    };
  },
};
