import { ChannelService } from '@butler/seam-channel';

/** 一个**没有** check 的通道：用来证明"自检是可选的" */
export class PlainChannel extends ChannelService {
  id = 'plain';
  async start() {}
  async stop() {}
  async sendText() { return {}; }
  async sendFile() { return {}; }
}

export default PlainChannel;
