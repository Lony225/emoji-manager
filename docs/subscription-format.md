# 订阅清单格式

一个订阅地址就是一个可以通过 http(s) 访问的 JSON 文件。把它和图片一起放到任何静态托管
（GitHub Pages、对象存储、自己的服务器、甚至 Gitee 仓库的 raw 地址）上即可。

## 最简形式

```json
{
  "name": "猫猫表情包",
  "stickers": [
    "images/01.gif",
    "images/02.png"
  ]
}
```

- `stickers` 里的字符串就是图片地址。**相对地址按清单文件所在位置解析**，
  所以 `https://example.com/packs/cats/pack.json` 里的 `images/01.gif`
  会变成 `https://example.com/packs/cats/images/01.gif`。
- 表情名默认取文件名（去掉扩展名）。

## 完整字段

```json
{
  "name": "猫猫表情包",
  "description": "可选，显示在订阅列表里",
  "homepage": "https://example.com/cats",
  "version": "2026.10",
  "tags": ["猫"],
  "stickers": [
    {
      "id": "happy",
      "url": "images/happy.gif",
      "name": "开心",
      "tags": ["开心", "笑"]
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `name` | 订阅 / 表情包名称，会成为分类名。缺省时用清单文件名 |
| `description` | 说明文字，可选 |
| `homepage` | 主页链接，可选（也可写 `url`） |
| `version` | 任意字符串，仅用于显示 |
| `tags` | 包级标签，会加到这个包里的每个表情上 |
| `stickers[].id` | **表情的唯一标识**，用于判断"这是同一个表情"。缺省时用图片的绝对地址 |
| `stickers[].url` | 图片地址（也可写 `src` / `image`）。支持 png / jpg / gif / webp / bmp / avif / svg |
| `stickers[].name` | 表情名（也可写 `title`） |
| `stickers[].tags` | 这个表情的标签 |

## 一个订阅包含多个表情包

用 `packs`，每个包会成为一个单独的分类：

```json
{
  "name": "我的表情合集",
  "packs": [
    {
      "key": "cats",
      "name": "猫猫",
      "tags": ["猫"],
      "stickers": ["cats/01.gif", "cats/02.gif"]
    },
    {
      "key": "dogs",
      "url": "dogs/pack.json"
    }
  ]
}
```

- 内联包：直接写 `name` + `stickers`，字段和单包清单一样。
- 引用包：只写 `url`，指向另一个单包清单文件（相对地址同样按本清单位置解析）。
- `key` 是包在订阅内的稳定标识，**建议写上**；缺省时用包名（引用包用其地址）。
  改了 `key` 会被当成新包，旧包的表情按"远端已移除"处理。
- 多包订阅会变成两级分类：订阅的 `name` 是一级分类，每个包是它下面的二级分类（主界面顶部的页签）。
  根级的 `stickers` 如果和 `packs` 同时存在，根级表情直接放在一级分类里。
- 包上可以写 `group`（父分类路径，多级用「 / 」连接，如 `"动物 / 猫"`）。它只在**导入 zip 表情包**时用来还原多级分类；
  作为订阅使用时忽略（订阅本身已经是一级分类）。

## 导出的 zip 表情包

应用的"导出"功能生成的 zip 就是这个格式：`manifest.json` + `images/` 目录。清单形如：

```json
{
  "name": "我的表情",
  "version": "2026-10-22",
  "generator": "Emoji Manager 0.1.0",
  "packs": [
    { "key": "…", "name": "猫猫", "group": "动物", "stickers": [ { "id": "…", "url": "images/cats/happy.png", "name": "开心", "tags": ["开心"] } ] },
    { "key": "uncategorized", "name": "未分类", "stickers": [ … ] }
  ]
}
```

- 每个分类一个包；二级分类用 `group` 记父分类名；未分类的表情放在 `key` 为 `uncategorized` 的包里。
- 导入时按名字匹配已有分类，没有就新建；名称、标签原样还原；内容相同的图片不会重复导入。
- 把解压后的文件夹放到网上，`manifest.json` 的地址就能当订阅地址用（此时所有包归在订阅名下）。

## 同步时发生什么

表情的身份 = 订阅 + 包的 `key` + 表情的 `id`。每次同步：

| 情况 | 处理 |
|---|---|
| 新的 id | 下载，放进包对应的分类，带上包标签和表情标签 |
| id 不变、`url` 变了 | 重新下载并替换本地文件 |
| id 不变、`name` 变了 | 如果用户没改过名字就跟随远端，改过则保留用户的 |
| id 不变、`tags` 变了 | 远端标签以新清单为准；用户自己加的标签保留 |
| 用户把表情移到了别的分类 / 未分类 | 保留，不会被拉回 |
| 用户删除了某个表情 | 记住它，之后不再拉回（可在订阅管理里恢复） |
| 远端不再包含某个 id | 默认在本地删除；订阅设置里可以改成保留 |
| 包的 `name` 变了 | 分类名跟随远端，除非用户重命名过该分类 |
| 子包清单抓取失败 | 跳过该包，不删除它已有的表情，错误显示在订阅页 |

## 限制

- 单个清单最多 200 个包，每个包最多 10000 个表情。
- 单张图片最大 100 MB；清单请求 30 秒超时，图片 60 秒超时。
- 只支持 `http://` 和 `https://`。
- 服务器最好返回正确的 `Content-Type`；没有扩展名的图片地址会按 `Content-Type` 识别格式。
- 如果用浏览器版（非桌面版），图片服务器需要允许跨域（`Access-Control-Allow-Origin`）。

## 示例

仓库里的 `examples/subscription/` 是一个完整的例子（运行 `pnpm samples` 生成图片），
用 `pnpm serve:samples` 可以在本机起一个订阅源：

- 单包：`http://127.0.0.1:8787/pack.json`
- 多包：`http://127.0.0.1:8787/index.json`
