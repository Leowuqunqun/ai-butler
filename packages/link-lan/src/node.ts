/**
 * `@butler/link-lan/node` —— **节点侧**入口。
 *
 * 一个包两个入口，跟 `wechat-agent-bridge` 是同一手法：两半共用线协议，
 * 但**装的机器不一样**。中枢那台装的是 `@butler/link-lan`（客户端），
 * 被遥控的那台装的是 `@butler/link-lan/node`（服务端）。
 *
 * 分开的理由不只是"干净"：节点那半依赖 `@butler/seam-agent`
 * （它要驱动本机的 agent），中枢那半不需要。分入口之后，
 * 只看中枢那半的人不用把这个依赖也拉进来。
 *
 * @module @butler/link-lan/node
 */

export { NodeService, NodeService as default } from './node-service.js';
