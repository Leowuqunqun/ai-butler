/**
 * **我们站上去的那个包，还是手册说的那个样子吗。**
 *
 * 手册第六、七节为"站在 `@larksuite/channel` 上"给了一组理由，第九节把它收成一句：
 *
 *   我们用它的理由不是"它是官方"，而是**能力清单 + MIT + 官方同源**
 *
 * 这三条腿里，**MIT** 和**官方同源**是**关于依赖包本身的事实** —— 会随着一次升版悄悄变
 * （换个 license、换个 author）。而它们一旦变了，手册那句话就变成假话，**没有任何东西会报错**。
 *
 * ⚠️ 为什么这三条非验不可：它们是**"要不要自带重连、去重、媒体上传"那个取舍**的支点
 * （第六节）。理由塌了，代码没塌 —— 那是最难发现的一类过期。
 *
 * 判据来自**装在这儿的那个包**（`node_modules` 里的 `package.json`），不是 npm 网站：
 * 这样它在离线、在 CI 里都能跑，而且验的正是**我们实际站上去的那一份**。
 * 包根目录是解析出来的，不写死 pnpm 的目录形状。
 *
 * ⚠️ **为什么是 `author` 而不是 `maintainers`**：发布出来的 tarball 里**根本没有**
 *    `maintainers` 字段（第 71 轮实测：装着的这份只有 17 个顶层字段，
 *    `maintainers` / `contributors` / `repository` / `homepage` / `bugs` / `funding` 全缺）。
 *    但 `author` 在，而且它写的就是 **`mazhe.nerd`** —— npm 上
 *    `@larksuiteoapi/node-sdk`（官方 node-sdk）的维护者名单里**同一个账号**。
 *    "官方同源"这条腿的证据，恰好落在这个字段上。
 *    ⚠️ 完整的维护者名单（9 个账号、全是 `@bytedance.com`）**不在 tarball 里**，
 *    只能上网查：`npm view @larksuite/channel maintainers`。手册第九节写清了这条命令。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** 解析出 `@larksuite/channel` 的包根目录，再读它自己的 `package.json`。 */
function installedMeta() {
  const entry = require.resolve('@larksuite/channel');
  // entry 形如 <pkg>/lib/xxx.js —— 往上找到写着这个名字的那一级 package.json
  let dir = dirname(entry);
  for (let i = 0; i < 6; i += 1) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (meta.name === '@larksuite/channel') return meta;
    } catch {
      // 这一级没有，继续往上
    }
    dir = dirname(dir);
  }
  throw new Error(`从 ${entry} 往上没找到 @larksuite/channel 的 package.json`);
}

test('★ 手册说的"MIT + 官方同源"两条腿，在装着的那个包上仍然成立', () => {
  const meta = installedMeta();

  // 第一条腿：MIT
  assert.equal(
    meta.license,
    'MIT',
    `手册说我们站上来的一条理由是 **MIT**，可装着这份的 license 是 ${JSON.stringify(meta.license)}。` +
      ' 换许可证是能改变"要不要用这个依赖"的事 —— 手册那组理由得跟着重写，不能悄悄过期。',
  );

  // 第二条腿：官方同源 —— author 就是官方 node-sdk 维护者名单里的那个账号
  assert.equal(
    meta.author,
    'mazhe.nerd',
    '手册说它与官方 node-sdk **同批 ByteDance 账号**（第九节第 1 条），实证是：' +
      '`npm view @larksuiteoapi/node-sdk maintainers` 里有 `mazhe.nerd@bytedance.com`，' +
      `而这个包的 author 正是它。现在 author 变成了 ${JSON.stringify(meta.author)} —— ` +
      '换作者是"官方同源"这条理由的直接证据，手册得跟着改。',
  );

  // ⭐ 那条**反证**：官方同源的兄弟包有 repository/homepage，它没有 ——
  //    「没有官方文档明说它是一等公民」说的就是这个。真加上了，是好消息，手册得重写。
  assert.ok(
    !meta.repository && !meta.homepage,
    '⚠️ 这个包**多了** repository/homepage 字段（' +
      `repository=${JSON.stringify(meta.repository)}, homepage=${JSON.stringify(meta.homepage)}）—— ` +
      '那是好事，但手册第九节那句"官方程度仍是 △、没有官方文档明说它是一等公民"就是旧话了，' +
      '得回去重读一遍再改。',
  );
});
