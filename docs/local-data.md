# 本地资料与文件安全 / Local data

本页描述当前源码的行为。安装包是否通过完整用户操作验收，见 [发布状态](../README.zh-CN.md)。

## 中文

- **原视频：**导入、转写和剪辑读取原文件，导出另存 MP4。项目引用原视频，没有把它装进项目文件。请保留原文件；跨电脑移交需要同时带上素材。
- **项目与草稿：**`.clipdeck` 和应用本地的恢复草稿包含转写文字、选段、备注与素材引用。它们是普通本地 JSON，没有应用层加密。分享项目前检查这些内容；电脑备份或同步软件也可能同步它们。
- **临时媒体：**预览副本、转写音频和导出中间文件可能包含原片内容。正常结束尝试清理任务自己的中间文件，关闭应用会等待清理任务结束；下次启动检查遗留文件的归属。目录被移动、替换或无法确认归属时保留并提示，不猜测删除。用户最终导出的文件保留。
- **模型：**点击下载模型时会连接固定的上游模型地址，下载内容经过固定大小和摘要校验；也可以选择已有本地模型。视频处理流程不上传素材，识别 worker 禁止出站联网。普通应用启动不等于整棵进程树已通过系统级断网证明；具体离线验证边界见 [安装包说明](packaging.md)。
- **保存与退出：**关闭窗口先处理正在编辑的字段和任务，允许继续工作或取消关闭。取消保存、保存失败或恢复草稿写入失败会保留窗口。项目采用临时文件加原子替换，转写失败或取消不替换已有完整结果。
- **移动或改变素材：**重新关联后探测真实媒体参数。相同内容保留剪辑；不同内容使旧时间锚点失效，相关选段需要复核。导出不允许覆盖已导入的原素材。
- **存储空间：**转写和导出检查预计解码音频占用，多个本地任务共享预留量。它不保证压缩视频一定能放下，也无法阻止其他程序同时占用磁盘。解码、校验或发布前的存储错误会导致失败。成片发布后若中间文件清理失败，保留已生成的成片，并提示清理问题。

应用资料目录保存恢复草稿、素材授权、模型设置、下载的模型、预览缓存和任务临时目录；导出目录可能出现任务自己的隐藏中间目录。卸载应用本体不会自动删除这些资料。清理前关闭应用，并保存需要的项目、原素材和成片；不要把完整应用资料目录当作公开反馈附件。

本地处理不能防止同一账户下的其他程序读取文件，也不能替代系统账户保护、磁盘加密或备份。临时清理会核对目录身份与标记，但不宣称抵抗恶意同用户进程在最后核对和删除之间抢换目录。

## English

This page describes the current source behavior; [release status](../README.md) separately states whether a packaged user journey has been accepted.

| Data | Where and how it is handled |
| --- | --- |
| Original videos | Read for import, playback, recognition and rendering. Projects reference originals; keep them when moving a project. Export cannot target an imported original. |
| Projects and recovery | Local JSON containing transcripts, cuts, notes and source references. There is no application-level encryption. Review it before sharing; OS backup/sync software can copy it. |
| Temporary media | Preview copies, decoded audio and export staging can contain recording content. Normal completion attempts owned cleanup; shutdown waits for task cleanup to settle. Startup checks crash leftovers. Uncertain, moved or replaced directories are preserved with a warning. Final exports remain. |
| Models and network | Explicit model download contacts fixed upstream resources and verifies pinned sizes and hashes. Existing verified local models can be selected. The media workflow does not upload recordings; the ASR worker denies outbound networking. Whole-application kernel network denial is a separate, unclaimed boundary; see [packaging](packaging.md). |
| Save and close | Pending edits and active tasks are handled before closing. Cancelled saves or failed project/recovery writes keep the window open. Project replacement is atomic; failed/cancelled recognition retains the previous complete transcript. |
| Source changes | Relinking probes actual media metadata. Equal content preserves edits; changed content invalidates old anchors and requires cut review. |
| Disk capacity | Concurrent media tasks share estimated decoded-audio reservations. Compressed video size and storage consumed by other applications are outside that estimate. Decode/validation/storage failures before publication fail explicitly. A cleanup failure after successful export publication retains the completed output and reports a cleanup warning. |

Application data contains recovery, source grants, model settings/downloads, preview cache and task directories. Export destinations can contain owned hidden staging directories. Removing the app bundle does not automatically delete this data. Close the app before manual cleanup, retain needed projects/originals/exports, and avoid attaching the entire application-data directory to a public issue.

Local processing does not prevent other programs under the same account from reading files. It does not replace OS account protection, disk encryption or backups. Cleanup checks directory identities and ownership markers; it does not claim atomic protection against a hostile same-user process replacing a path between the final check and deletion.
