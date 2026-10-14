/**
 * **手册第五节那句"契约就这几个方法"，和真接口还是不是同一件事。**
 *
 * `docs/CHANNEL-FEISHU.md` 第五节（写给"要动手接一个新通道"的人）头一句是：
 *
 *   新通道的全部契约就是 5 个方法（`start` / `stop` / `sendText` / `sendFile` + 可选 `check`）
 *
 * 这句话是整节的**地基** —— 下面那张"逐项对到飞书"的表就挂在这几行上。它也是**唯一**一句
 * 把整个契约数出来给人看的话。
 *
 * ⚠️ 它**会静默过期**：只要有人在 `ChannelService` 上再加一个 `abstract` 方法，手册那句就
 * 变成假话，而**没有任何东西会报错** —— 文档检查只盯链接 / 出处 / 命令，TypeScript 当然也
 * 不管一句散文。后果是照着手册接通道的人**漏实现一个方法**，然后在运行期撞上"抽象方法没实现"。
 *
 * 所以这里把两边钉在一起：从**接口源码**里用 TypeScript 的语法树数出"必须实现的"和"可选的"，
 * 再从**手册**里把那句话读出来比对。
 *
 * ⚠️ 为什么不用正则去源码里找 `abstract`：那是在数**字符串**，不是在数**方法**。
 *    `export abstract class` 自己就带一个 `abstract`；注释里也可能写着"abstract"。
 *    语法树问的是"这个类成员是不是抽象方法"，那才是要守的东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本仓根目录（这个文件在 `<repo>/packages/channel-feishu/test/`） */
const REPO = join(HERE, '..', '..', '..');
const SEAM = join(REPO, 'packages', 'seam-channel', 'src', 'index.ts');
const DOC = join(REPO, 'docs', 'CHANNEL-FEISHU.md');

/** 手册第五节那句地基的原文（改了就一起改这里，改不了说明你改的是承诺）。 */
const CONTRACT_SENTENCE = /新通道的全部契约就是\s*(\d+)\s*个方法（([^）]*)）/;

/**
 * 从 `ChannelService` 的声明里数出"必须实现的"和"可选的"方法名。
 *
 * - **必须实现的** = 带 `abstract` 修饰符的方法（不写就跑不起来）；
 * - **可选的** = 带 `?` 的方法（基类没给实现，但不写也能跑）。
 *
 * `setTyping` / `onMessage` / `offMessage` 都不算：它们是**基类给好实现**的，接通道的人不用管 ——
 * 手册那句"不用管"正是这个意思。`id` 也不算：它是属性，不是方法。
 */
function contractOf(source) {
  const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  let cls;
  const find = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'ChannelService') cls = node;
    ts.forEachChild(node, find);
  };
  find(sf);
  assert.ok(cls, '在 seam-channel/src/index.ts 里找不到 ChannelService 这个类');

  const required = [];
  const optional = [];
  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
    const isAbstract = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword);
    if (isAbstract) required.push(member.name.text);
    else if (member.questionToken) optional.push(member.name.text);
  }
  return { required: required.sort(), optional: optional.sort() };
}

test('★★ 手册第五节说的"契约就是这几个方法"，和 seam-channel 的真接口是同一件事', () => {
  const { required, optional } = contractOf(readFileSync(SEAM, 'utf8'));
  // 先钉住"真接口长什么样"。这两行变了，说明契约变了 —— 那手册那句话就得跟着改。
  assert.deepEqual(required, ['sendFile', 'sendText', 'start', 'stop'], 'ChannelService 上"必须实现"的方法变了');
  assert.deepEqual(optional, ['check'], 'ChannelService 上"可选"的方法变了');

  const doc = readFileSync(DOC, 'utf8');
  const m = CONTRACT_SENTENCE.exec(doc);
  assert.ok(
    m,
    '手册第五节那句"新通道的全部契约就是 N 个方法（…）"找不到了 —— 是改写了、还是删了？\n' +
      '  这句话是那一节的地基（下面整张对照表都挂在它上面），换说法可以，但它得还在，' +
      '而且得和真接口对得上。',
  );

  const claimedCount = Number(m[1]);
  // 括号里写成 `start` / `stop` / … + 可选 `check` —— 按 "+ 可选" 切成必须的 / 可选的
  const [mustPart, optPart = ''] = m[2].split('+ 可选');
  const namesIn = (s) => [...s.matchAll(/`([A-Za-z]+)`/g)].map((x) => x[1]).sort();
  const claimedRequired = namesIn(mustPart);
  const claimedOptional = namesIn(optPart);

  assert.equal(
    claimedCount,
    required.length + optional.length,
    `手册说"${claimedCount} 个方法"，可接口上是 ${required.length} 个必须实现 + ${optional.length} 个可选`,
  );
  assert.deepEqual(
    claimedRequired,
    required,
    '手册列出的"必须实现"的方法和接口上的对不上（多了、少了、或改了名）',
  );
  assert.deepEqual(claimedOptional, optional, '手册说的"可选"方法和接口上的对不上');
});

test('★ 手册说 setTyping"基类默认 no-op，不用管" —— 基类那具空实现就得更在', () => {
  const sf = ts.createSourceFile('index.ts', readFileSync(SEAM, 'utf8'), ts.ScriptTarget.Latest, true);
  let body;
  const find = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'ChannelService') {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === 'setTyping') {
          body = member.body;
        }
      }
    }
    ts.forEachChild(node, find);
  };
  find(sf);

  assert.ok(body, 'ChannelService 上没有 setTyping 了 —— 手册第五节那张表得跟着改');
  assert.equal(
    body.statements.length,
    0,
    'setTyping 的基类实现不再是空的了。手册第五节说"飞书没有正在输入 → 基类默认 no-op，不用管"，' +
      '接通道的人会照这句话跳过它 —— 基类要是真做了什么（比如往平台发请求），这句就是假的。',
  );
});
