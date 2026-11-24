#!/usr/bin/env python3
"""把本地提交推到 GitHub（Git Data API），直推不可用时的替代。
用法：python3 push_cf_tg_checkin.py <branch> <commit-sha>
流程：base_tree + 改动文件内容内联建树 -> 建提交（author/committer 日期带 +0800）-> 更新分支 ref。
建出的提交 SHA 必须等于本地提交 SHA，否则说明日期/内容对不上，停下别推。
两个坑（GitHub API 会归一化，本地提交必须先对齐）：
- 日期：API 把 author/committer 日期归一化成 UTC（+0000），本地提交须用 +0000 日期
  （`git commit --amend --date="... +0000"`，时刻不变），否则 SHA 对不上。
- 消息：API 会去掉消息尾部的换行/空白，本地提交须用 `git commit-tree` 且消息不带尾换行
  （`printf '%s' "$MSG" | git commit-tree ... -F -`），否则 SHA 对不上。
  所以本脚本发给 API 的消息先 `rstrip()`，再按去尾后的消息算期望 SHA 去比对。
凭据走 github-backup 连接器的 surrogate（不打印、不写日志）。"""
import json
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

REPO = "Yan2Zai/cf-tg-checkin"
API = f"https://api.github.com/repos/{REPO}"


def gh(method, path, payload=None):
    token = dynamic_credential_entry("custom.github-backup")["surrogate"]
    cmd = [
        "curl", "-s", "-f", "-X", method,
        f"{API}{path}",
        "-H", f"Authorization: Bearer {token}",
        "-H", "Accept: application/vnd.github+json",
        "-H", "User-Agent: muse-cf-tg-checkin-push/1.0",
    ]
    if payload is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", "@-"]
    out = subprocess.run(
        cmd, input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise SystemExit(f"GitHub API {method} {path} 失败：{out.stdout.strip() or out.stderr.strip()}")
    return json.loads(out.stdout) if out.stdout.strip() else {}


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout.strip()


def main():
    branch, sha = sys.argv[1], sys.argv[2]
    parent = git("rev-parse", f"{sha}~1")
    parent_tree = git("rev-parse", f"{sha}~1^{{tree}}")
    message = git("log", "-1", "--format=%B", sha).rstrip()  # API 会去尾换行，先去掉再发
    author_date = git("log", "-1", "--format=%aI", sha)  # 2026-11-25T04:27:42+08:00
    author_name = git("log", "-1", "--format=%an", sha)
    author_email = git("log", "-1", "--format=%ae", sha)
    # 改动文件（路径 + mode + 内容，全部是文本文件，内容内联进树）
    files = git("diff", "--name-only", f"{parent}", sha).splitlines()
    entries = []
    for path in files:
        mode = git("ls-tree", "-r", sha, "--", path).split()[0]
        content = subprocess.run(["git", "show", f"{sha}:{path}"], capture_output=True, check=True).stdout.decode("utf-8")
        entries.append({"path": path, "mode": mode, "type": "blob", "content": content})
    tree = gh("POST", "/git/trees", {"base_tree": parent_tree, "tree": entries})
    print("tree:", tree["sha"], "本地 tree:", git("rev-parse", f"{sha}^{{tree}}"))
    if tree["sha"] != git("rev-parse", f"{sha}^{{tree}}"):
        raise SystemExit("树 SHA 对不上，停下不推")
    who = {"name": author_name, "email": author_email, "date": author_date}
    commit = gh("POST", "/git/commits", {
        "message": message, "tree": tree["sha"], "parents": [parent],
        "author": who, "committer": who,
    })
    print("commit:", commit["sha"], "本地:", sha)
    if commit["sha"] != sha:
        raise SystemExit("提交 SHA 对不上，停下不推（日期/内容有出入）")
    ref = gh("PATCH", f"/git/refs/heads/{branch}", {"sha": sha, "force": False})
    print("ref 已更新：", ref["ref"], "->", ref["object"]["sha"])
    print("PUSH OK", sha)


if __name__ == "__main__":
    main()
