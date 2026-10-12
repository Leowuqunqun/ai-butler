/**
 * 节点上的假大脑。
 *
 * 报两行进度、把话原样回过来 —— 用来验证进度真的跨进程传回去了。
 * 话里提到"文件"时，还会**在节点这台机器上真的写出一个文件**并交出去，
 * 用来验证"那台电脑上产出的文件，微信里真的收得到"。
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentService } from '@butler/seam-agent';

export default class NodeAgent extends AgentService {
  id = 'node-agent';

  constructor(ctx, config) {
    super(ctx);
    this.config = config ?? {};
  }

  async run(req) {
    req.onProgress?.('节点上开工了');
    req.onProgress?.(`收到：${req.text}`);

    const reply = { sessionId: req.sessionId ?? 's-1', text: `那台电脑说：${req.text}` };
    if (!req.text.includes('文件')) return reply;

    // 这个路径**只在这台机器上存在** —— 中枢那边根本读不到它，
    // 所以它必须靠取件凭证搬过去，否则微信会去读一个不存在的文件
    const path = join(tmpdir(), `butler-node-fixture-${process.pid}-${Date.now()}.txt`);
    writeFileSync(path, '这是那台电脑上写出来的内容');
    return { ...reply, files: [{ path, name: '那台电脑的文件.txt' }] };
  }
}
