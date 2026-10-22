# 表情包预览网站

一个小型 Node 服务：公开浏览表情包、点击复制、一键导入表情包管理器；管理员登录后上传和整理。
部署在 https://emoji.ourmeetismyserendipity-pplovecpu.fun 。

## 功能

- 首页：按表情包分组展示，搜索，点击表情复制到剪贴板（浏览器只能复制 PNG，动图复制的是第一帧），右键复制链接 / 下载原图
- 「导入到表情包管理器」：打开 `emojimanager://subscribe?url=…` 唤起桌面应用添加订阅（需要应用 1.1 以上）；也可以复制订阅地址或下载 zip 手动导入
- `/manifest.json`、`/packs/<id>/manifest.json`、`/groups/<一级>/<二级>/manifest.json`：订阅清单（整站 / 单个表情包 / 一个分组连同它下面的所有表情包），格式见仓库的 `docs/subscription-format.md`
- `/all.zip`、`/packs/<id>.zip`、`/groups/<一级>/<二级>.zip`：打包下载，桌面应用「导入表情包压缩包」可直接读
- 表情包可以放在分组里（后台编辑时填“所属分组”，如 `动物 / 猫`）；从桌面应用导出的 zip 导入后会保留原来的分类层级，首页和后台都按树展示
- `/admin`：管理员登录后新建表情包、拖拽上传（按内容去重）、改名改标签、移动删除、导入桌面应用导出的 zip、站点设置、改口令

## 本地运行

```bash
cd site
pnpm install
node server/set-password.mjs 你的口令     # 设置管理员口令（数据目录默认 site/data）
node server/index.mjs                     # http://127.0.0.1:8844
```

环境变量：`PORT`（默认 8844）、`HOST`（默认 127.0.0.1）、`EMOJI_DATA_DIR`（数据目录）、`EMOJI_ADMIN_PASSWORD`（启动时设置口令，仅第一次需要）。

## 部署到服务器

第一次（建用户、systemd 服务、nginx 站点）：

```bash
bash site/deploy/deploy.sh --init
ssh PP "cd /var/www/emoji && sudo -u emoji EMOJI_DATA_DIR=/var/www/emoji/data node server/set-password.mjs"
ssh PP "certbot --nginx -d emoji.ourmeetismyserendipity-pplovecpu.fun"
```

之后更新代码：

```bash
bash site/deploy/deploy.sh
```

数据在服务器的 `/var/www/emoji/data`（`index.json` + `images/`），备份这个目录即可。日志：`journalctl -u emoji-site -f`。
